#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// Context-fill gauge (mt#4291) — show the agent its own context fill.
//
// An LLM has no introspective access to its token count: no API exposes one to
// the model, so from the inside turn 200 feels like turn 5. That is why the
// failure this measures is possible at all — the agent is not ignoring a gauge,
// it has none. The only way to supply one is from OUTSIDE the model: read the
// transcript the harness writes, compute fill, and hand the number back as text.
//
// DISPLAY-ONLY, by principal decision (ask#8878, closed 2026-08-18). The gauge
// reports; nothing acts on it. No handoff is triggered, no successor dispatched,
// no session stopped. The `work-completion.mdc` amendment that would authorize
// any of that is analysed in mt#2531 §Authorization and deliberately NOT landed.
//
// What this does NOT claim: that fill predicts quality decay. Measured over 545
// local sessions (mt#2531 §Findings), correction markers sit at ~37.8% median
// fill while sessions routinely pass 60% uneventfully — fill does not predict
// them. What fill DOES predict, by construction rather than by inference, is the
// harness's own auto-compaction: that event triggers ON a token count, so
// predicting it is arithmetic. Observed 12 times at 99.6% median fill, each
// collapsing context ~996K -> ~107K.
//
// @see mt#2531 — the research pass (§Findings carries the evidence + event matrix)
// @see ADR-031 — "anchor at Stop; detect and inject at UserPromptSubmit". This
//      guard detects and injects at UserPromptSubmit and needs no Stop anchor:
//      it reads ONE usage record, not a bounded turn window.
// @see ADR-024 — its rung ladder escalates PARAPHRASE recall. This is a numeric
//      comparison with no paraphrase axis, so it is Rung-1 by construction and
//      never climbs. Same posture turn-end-bare-ref-scan records.
// @see ADR-032 — threshold tuning consumes a per-fire LABELED RESPONSE signal.
//      No such emitter exists for this guard, so the thresholds below are
//      hand-set and OUTSIDE that loop until one does. Said plainly rather than
//      implied.
// ---------------------------------------------------------------------------

import { readTunedThreshold } from "./types";
import { readTunedValue } from "./guard-tuning-store";
import type { ClaudeHookInput } from "./types";
import type { TranscriptLine } from "./transcript";
import type { DispatchContext, GuardOutcome } from "./registry";
import { logEvaluationRecord } from "./dispatcher";

// ---------------------------------------------------------------------------
// Calibration gate
// ---------------------------------------------------------------------------

/**
 * Ships FALSE: the gauge records without injecting, so its thresholds can be
 * checked against real fill distributions before any of them reach the agent's
 * context. Same log-only entry the rest of the family uses — see
 * `pre-narration`'s flag (mt#4286) for the current instance of the pattern.
 *
 * Flipping this is a calibration decision, not a code cleanup: read the
 * evaluation stream first and confirm the tiers land where intended.
 */
export const INJECTION_ENABLED = false;

/** Bespoke opt-out, in addition to the shared `MINSKY_HOOK_OVERRIDE` channel. */
export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_CONTEXT_FILL_GAUGE";

const EVALUATION_LOG_NAME = "context-fill-gauge";

// ---------------------------------------------------------------------------
// Denominator
// ---------------------------------------------------------------------------

/**
 * Model id -> context window, in tokens.
 *
 * A small owned table on purpose. The repo's real model catalog
 * (`packages/domain/src/ai/model-cache/model-limits-catalog.ts`) fetches ~1.6MB
 * over the network with a 20s timeout — correct for AI-completion routing, and
 * far outside the latency budget every sibling injector holds itself to. A hook
 * that blocks a turn on a network round-trip is worse than one that does not
 * know an exotic model's window.
 *
 * The 1M figures are EMPIRICAL, not vendor-documented: across 553 local
 * transcripts these three models each cluster tight against a ~999K ceiling
 * before a hard reset, observed 12 times (mt#2531 §Findings). `claude-sonnet-5`
 * was never observed above 222,427 here — too small a sample to pin a ceiling,
 * so it is deliberately absent and takes the conservative fallback.
 */
export const KNOWN_MODEL_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  "claude-opus-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-fable-5": 1_000_000,
});

/**
 * Used when `message.model` is absent or unrecognized.
 *
 * Deliberately SMALL. The two errors are not symmetric: under-estimating the
 * window over-reports fill, which costs one noticeable line; over-estimating it
 * under-reports fill, which costs the gauge its entire purpose and produces no
 * signal that anything went wrong. Prefer the loud failure.
 */
export const FALLBACK_WINDOW_TOKENS = 200_000;

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

/**
 * Expressed as a RATIO rather than the absolute token counts mt#2531 §Findings
 * derived (800K / 950K), because the denominator varies per model and an
 * absolute cutoff calibrated on a 1M window is unreachable on a 200K one.
 * 0.80 and 0.95 are those same figures against the 1M window they were observed
 * on.
 *
 * Both are DISPLAY cutoffs, not triggers — which is what makes a wrong value
 * cheap here. A misplaced tier shows a line slightly early; it does not abort
 * anything. Their provenance, stated plainly because it is uneven:
 *
 *   WARN 0.80 — the tail-entry inflection in the observed session-max
 *   distribution (59.6% of 545 sessions cross 50%; only 18.3% cross 80%). Tied
 *   to NO observed quality failure. It marks "this session is now in the long
 *   tail", nothing more.
 *
 *   CRITICAL 0.95 — p10 of observed auto-compaction onsets (982,748 of 1M)
 *   minus room to actually do something about it. That subtraction assumed ~15
 *   turns at the observed 2,203 median tokens/turn, and the 15 is UNGROUNDED:
 *   nobody has measured what a handoff costs. Treat it as a placeholder that
 *   calibration should replace, not as a derived constant.
 */
export const WARN_FILL_RATIO = readTunedThreshold("MINSKY_CONTEXT_FILL_WARN_RATIO_PCT", 80, {
  readTunedValueFn: (key) => readTunedValue(key),
});
export const CRITICAL_FILL_RATIO = readTunedThreshold(
  "MINSKY_CONTEXT_FILL_CRITICAL_RATIO_PCT",
  95,
  { readTunedValueFn: (key) => readTunedValue(key) }
);

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export interface UsageReading {
  model?: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface FillMeasurement {
  fillTokens: number;
  windowTokens: number;
  windowSource: "known-model" | "fallback-default";
  fillRatioPct: number;
  model?: string;
  assistantTurnCount: number;
  tier: "ok" | "warn" | "critical";
}

/** A `usage` block as it appears on an assistant record. Fields are optional because the source is JSON. */
interface RawUsage {
  input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
}

function asTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Walk BACKWARD for the most recent assistant record carrying `usage`.
 *
 * Backward and single-record, unlike silent-stretch / wall-of-text, which need
 * the whole turn's contents and therefore a bounded window. The current context
 * size is a point reading: the last one wins, and everything before it is
 * already folded into that number by the cache accounting.
 *
 * `parseTranscript` casts each line rather than validating it, so `usage` and
 * `model` survive at runtime even though `TranscriptLine.message` does not
 * declare them — hence the local cast here. Widening that shared type is a
 * separate change this guard deliberately does not make (mt#2544 / mt#3650 both
 * have `transcript.ts` in flight).
 */
export function findLastUsage(lines: readonly TranscriptLine[]): UsageReading | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line?.type !== "assistant") continue;
    const message = line.message as { model?: unknown; usage?: RawUsage } | undefined;
    const usage = message?.usage;
    if (!usage || typeof usage !== "object") continue;
    return {
      model: typeof message?.model === "string" ? message.model : undefined,
      inputTokens: asTokenCount(usage.input_tokens),
      cacheCreationTokens: asTokenCount(usage.cache_creation_input_tokens),
      cacheReadTokens: asTokenCount(usage.cache_read_input_tokens),
    };
  }
  return null;
}

/**
 * Tokens fed to the model on that call — the live context size.
 *
 * `output_tokens` is deliberately excluded. It is what the call PRODUCED, not
 * what it was given; on the next call it reappears inside `cache_read`, so
 * including it here would double-count it one turn early.
 *
 * Nothing special-cases a compaction boundary, and nothing should: after the
 * harness compacts, `cache_read_input_tokens` reflects the post-compaction
 * state, so this sum resets on its own (observed ~996K -> ~107K). The reset is
 * the correct reading of headroom. It is NOT a statement about session health —
 * a session that has already compacted has already taken the loss.
 */
export function computeFill(reading: UsageReading): number {
  return reading.inputTokens + reading.cacheCreationTokens + reading.cacheReadTokens;
}

export function resolveWindow(model: string | undefined): {
  tokens: number;
  source: "known-model" | "fallback-default";
} {
  const known = model ? KNOWN_MODEL_WINDOWS[model] : undefined;
  return known !== undefined
    ? { tokens: known, source: "known-model" }
    : { tokens: FALLBACK_WINDOW_TOKENS, source: "fallback-default" };
}

/** Assistant records in the transcript — the cheapest available turn-count proxy. */
export function countAssistantTurns(lines: readonly TranscriptLine[]): number {
  let count = 0;
  for (const line of lines) if (line?.type === "assistant") count++;
  return count;
}

export function measureFill(lines: readonly TranscriptLine[]): FillMeasurement | null {
  const reading = findLastUsage(lines);
  if (reading === null) return null;

  const fillTokens = computeFill(reading);
  const window = resolveWindow(reading.model);
  const fillRatioPct = window.tokens > 0 ? (fillTokens / window.tokens) * 100 : 0;

  return {
    fillTokens,
    windowTokens: window.tokens,
    windowSource: window.source,
    fillRatioPct: Math.round(fillRatioPct * 10) / 10,
    model: reading.model,
    assistantTurnCount: countAssistantTurns(lines),
    tier:
      fillRatioPct >= CRITICAL_FILL_RATIO
        ? "critical"
        : fillRatioPct >= WARN_FILL_RATIO
          ? "warn"
          : "ok",
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * One line, informational.
 *
 * It states a number and names `/handoff` as AVAILABLE. It does not tell the
 * agent to hand off, to stop, or to wind down — the principal held that half
 * (ask#8878), and `context-fill-gauge.test.ts` asserts the absence of an
 * imperative so the constraint is enforced by a test rather than by review.
 *
 * The phrase "context-density indicator" is load-bearing and not decoration:
 * it is the `/handoff` skill's OWN auto-trigger vocabulary
 * (`.minsky/skills/handoff/SKILL.md`), so using it verbatim means that skill
 * needs no edit to recognize this signal if the agent chooses to act on it.
 */
export function buildGaugeLine(measurement: FillMeasurement): string {
  const window =
    measurement.windowSource === "fallback-default"
      ? `${measurement.windowTokens.toLocaleString()} assumed (model ${measurement.model ?? "unknown"} not in the window table)`
      : measurement.windowTokens.toLocaleString();

  return [
    `[context-fill-gauge] Context-density indicator: ${measurement.fillRatioPct}% ` +
      `(${measurement.fillTokens.toLocaleString()} of ${window} tokens, ` +
      `${measurement.assistantTurnCount} assistant turns).`,
    "",
    "This is a reading, not an instruction — no action is required and nothing is wrong. " +
      "`/handoff` exists if you want to checkpoint; whether to use it is yours to judge.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Guard entry point
// ---------------------------------------------------------------------------

export interface RunDeps {
  logEvaluationRecordFn?: typeof logEvaluationRecord;
}

/**
 * Records on EVERY turn that has a resolvable usage record, not only above
 * threshold.
 *
 * A fire-only stream can say "it happened again" and can never say "it stopped
 * happening" (mt#3583) — and here the non-firing rows are the more valuable
 * half: they are the fill distribution this guard's thresholds have to be
 * checked against, plus the turn counts a future turn-structure trigger would
 * be derived from. Turn count is recorded and triggered on by NOBODY; it is
 * instrumentation for a question we cannot answer yet.
 */
export function run(
  input: ClaudeHookInput,
  ctx: DispatchContext,
  deps: RunDeps = {}
): GuardOutcome | null {
  const logEvaluation = deps.logEvaluationRecordFn ?? logEvaluationRecord;

  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  const isOverride =
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes";
  if (isOverride) {
    // Record the override rather than returning silently (PR #3144 R2).
    //
    // The sibling guards this branch is modelled on return `auditLines` alone,
    // and for a fire-detector that is defensible: a suppressed FIRE is a
    // non-event. It is not defensible here. This guard's product is a
    // CONTINUOUS distribution — every turn contributes a row, and the
    // thresholds are meant to be re-derived from it. An override that writes
    // nothing therefore does not suppress a fire; it punches a hole in the
    // sample, and the hole is indistinguishable from "the session had no
    // resolvable usage record". A later reader would silently under-count.
    //
    // So: mark the gap. No measurement is taken — the override means do not do
    // the work — but the stream says plainly that a turn was skipped and why.
    logEvaluation(
      EVALUATION_LOG_NAME,
      {
        timestamp: new Date().toISOString(),
        session_id: input.session_id,
        guardName: "context-fill-gauge",
        overridden: true,
        overrideAck: overrideVal,
        fired: false,
      },
      { fallbackCwd: input.cwd }
    );
    return {
      auditLines: [
        `[context-fill-gauge] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  if (!input.transcript_path) return null;

  const lines = ctx.transcriptLines;
  if (lines.length === 0) return null;

  // Cold start: no assistant record has been written yet. Fail open — this is
  // the ordinary first-turn state, not an error.
  const measurement = measureFill(lines);
  if (measurement === null) return null;

  logEvaluation(
    EVALUATION_LOG_NAME,
    {
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      guardName: "context-fill-gauge",
      fillTokens: measurement.fillTokens,
      windowTokens: measurement.windowTokens,
      windowSource: measurement.windowSource,
      fillRatioPct: measurement.fillRatioPct,
      assistantTurnCount: measurement.assistantTurnCount,
      ...(measurement.model !== undefined ? { model: measurement.model } : {}),
      tier: measurement.tier,
      fired: measurement.tier !== "ok",
    },
    { fallbackCwd: input.cwd }
  );

  if (measurement.tier === "ok") return null;

  const outcome: GuardOutcome = {
    calibration: {
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      fillTokens: measurement.fillTokens,
      windowTokens: measurement.windowTokens,
      windowSource: measurement.windowSource,
      fillRatioPct: measurement.fillRatioPct,
      assistantTurnCount: measurement.assistantTurnCount,
      ...(measurement.model !== undefined ? { model: measurement.model } : {}),
      tier: measurement.tier,
    },
  };

  if (INJECTION_ENABLED) {
    outcome.additionalContext = buildGaugeLine(measurement);
  }

  return outcome;
}

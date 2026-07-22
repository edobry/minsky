#!/usr/bin/env bun
// UserPromptSubmit hook: detect a silent tool-only stretch — a run of tool
// calls with no user-visible assistant TEXT in between — that crossed the
// heartbeat cadence threshold without one ever firing, and log a calibration
// record. Per mt#2824.
//
// **Why this exists.** Long tool-only stretches emit zero user-visible text,
// and the operator cannot distinguish "working" from "hung": two separate
// conversations (a9c1a09b at 24 minutes, ac4f5675 at 28 minutes) ended with
// the operator interrupting healthy in-flight tool calls because there had
// been no visible progress for that long. This is the DETECTION layer (the
// discipline layer — a rule bullet requiring the agent to narrate — lives in
// `.minsky/rules/user-preferences.mdc`).
//
// **Calibration-first (mt#2263 detector ladder / ADR-024).** v1 logs matches
// to JSONL and injects NOTHING — `additionalContext` is never emitted here.
// Graduating to injection is a follow-up decision made after reviewing the
// false-positive rate accumulated in the calibration log.
//
// **Cadence (pinned at planning, 2026-07-15).** A silent stretch is flagged
// when EITHER threshold is crossed, whichever comes first:
//   - 10 minutes of wall-clock silence since the last assistant TEXT output, OR
//   - 15 consecutive tool calls with no assistant TEXT output in between.
// Grounding: the two originating interrupts landed at 24 and 28 minutes of
// silence, so this cadence yields >= 2 heartbeats before either historical
// interrupt point (RFC: Communication altitude's heartbeat-floor target of
// ~10 minutes matches).
//
// **Measurement (mt#3027 — WITHIN-TURN only).** Walks the just-completed
// turn (`extractLastAssistantTurn`) line by line, tracking runs of
// consecutive tool_use blocks bounded by assistant TEXT lines (a TEXT line
// resets the run — mirrors the discipline-layer rule that narrating resets
// the silent-stretch clock). Each run's wall-clock span is measured strictly
// from the run's OWN start (the prior TEXT line, or the turn's opening
// prompt when no TEXT has occurred yet) to the LAST TOOL CALL actually
// observed in that run — never to the timestamp of a LATER real user
// prompt. A run with zero tool calls can never match (structurally, not via
// a post-hoc filter): `hadTextInTurn: true` with no trailing tool calls
// yields `toolCallCount: 0` and is therefore never a candidate.
//
// The v1 implementation measured the gap as (last-text-or-turn-start) to
// (the NEXT real user prompt's timestamp) — i.e. it silently folded in
// inter-turn user-idle time. The 2026-07-21 calibration round's 13 new
// fires were entirely this contamination: every record had
// `hadTextInTurn: true` (the turn's last narration was followed by nothing
// further), yet `gapMinutes` read in the hundreds or tens of thousands
// (315, 441, 36710, 50902, ...) because the "gap" extended all the way to
// whenever the operator happened to submit their NEXT prompt — sometimes
// days later. A resumed conversation after N days must never fire; this
// walk only ever measures timestamps that appear WITHIN the completed turn
// itself, so inter-turn idle is structurally excluded from the measured
// span, not filtered after the fact.
//
// This deliberately reuses the shared turn-boundary + text/tool-use
// extraction helpers in `./transcript` rather than naive `role === "user"`
// checks — Claude Code records `tool_result` blocks as USER-ROLE transcript
// lines, so a naive scan would misclassify tool-result rows as human
// silence-breakers and undercount the stretch. Skill-invocation bodies also
// register as user-role text in the transcript (another reason to use the
// real-prompt-boundary helper rather than scanning role fields directly).
//
// **Stale turn re-measurement (mt#3003).** A SEPARATE bug from the mt#3027
// gap-semantics fix above: this guard's `run()` used `ctx.transcriptLines`
// (D6) as-is — the SAME flattened parent+all-subagent-transcripts array
// wall-of-text-detector.ts independently root-caused for its own consumption
// (mt#3028, see that file's header comment). Because `resolveTranscriptCandidates`
// (mt#2637) always places subagent transcript files AFTER the parent file,
// and those subagent files stop growing once the subagent completes, the
// last-two-real-prompt anchor `extractLastAssistantTurn` slices between can
// get permanently stuck inside a STATIC subagent transcript segment — every
// subsequent hook firing then re-measures the exact same frozen turn,
// producing the identical calibration record repeated across many
// subsequent (sometimes many-day-apart) prompts. Investigation against the
// three sessions the mt#3003 spec named (3bf59029, 2c9ac5e6 — both
// wall-of-text repeats; 762cde32 — the silent-stretch repeat) confirmed all
// three have populated `subagents/` dirs and found NO missed-prompt-shape
// bug in `findRealPromptIndices`/`isRealUserPrompt` itself — every genuine
// human prompt, slash-command echo, and tool_result line was correctly
// classified. Fix: `resolveParentTranscriptLines` (`transcript.ts`, shared
// with wall-of-text-detector.ts's `resolveTurnLines`) re-parses the PARENT
// transcript alone whenever more than one candidate is resolved, so a
// subagent's static content can never anchor this guard's own turn. A
// `buildTurnAnchor` dedupe check (keyed on the measured turn's own boundary
// timestamps, mirroring wall-of-text-detector.ts's content-hash dedupe) adds
// defense-in-depth on top, per the mt#3003 spec.
//
// @see .claude/hooks/causal-premise-detector.ts — sibling calibration-first pattern this file mirrors
// @see .claude/hooks/inject-dispatch-watchdog.ts — sibling silence detector (SUBAGENT side; this covers the MAIN agent's own silence)
// @see .minsky/hooks/transcript.ts — shared turn-boundary + timestamp + anchoring/dedup helpers
// @see mt#2263 — detector ladder (calibration before injection)
// @see mt#2637 — ctx.transcriptLines / needsTranscript wiring; resolveTranscriptCandidates subagent-ordering
// @see mt#2824 — origin (cadence + v1 measurement)
// @see mt#3027 — within-turn-only re-measurement (13/13 FP calibration round)
// @see mt#3028 — wall-of-text-detector.ts's independent fix for the same contamination mechanism
// @see mt#3003 — this task: shared anchoring fix (resolveParentTranscriptLines) + dedupe guard
// @see .minsky/hooks/registry.ts — ADR-028 GUARD_REGISTRY entry for this guard

import { readInput, readHostCap, deriveBudgets, findRepoRoot } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import {
  parseTranscript,
  extractLastAssistantTurn,
  extractAssistantText,
  extractToolUseNames,
  findRealPromptIndices,
  resolveParentTranscriptLines,
  resolveParentTranscriptLinesForPath,
  readLogTailText,
  sessionHasLoggedKey,
} from "./transcript";
import type { TranscriptLine } from "./transcript";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DispatchContext, GuardOutcome } from "./registry";

// ---------------------------------------------------------------------------
// Calibration gate — v1 is log-only, no injection
// ---------------------------------------------------------------------------

/**
 * When false (v1/calibration mode), the hook logs matches to JSONL and
 * injects NO additionalContext. Flip to true only after reviewing the FP
 * rate from the calibration log (mt#2263 ladder).
 */
export const INJECTION_ENABLED = false;

// ---------------------------------------------------------------------------
// Public API: exported constants
// ---------------------------------------------------------------------------

/**
 * Bespoke opt-out, checked directly inside `run()`/`main()` in addition to
 * the shared `MINSKY_HOOK_OVERRIDE` channel every GUARD_REGISTRY entry gets
 * for free via the dispatcher's `checkOverride()`. Mirrors the per-guard
 * override convention documented per-guard in `hook-files.mdc` (e.g.
 * `skill-staleness-detector.ts`'s `MINSKY_SKIP_SKILL_STALENESS`).
 */
export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_SILENT_STRETCH";

const CALIBRATION_LOG = ".minsky/silent-stretch-calibration.jsonl";

// ---------------------------------------------------------------------------
// Cadence thresholds (pinned at planning, 2026-07-15 — see header comment)
// ---------------------------------------------------------------------------

export const GAP_MINUTES_THRESHOLD = 10;
export const TOOL_CALL_THRESHOLD = 15;

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export interface SilentStretchMeasurement {
  /** true when any within-turn tool-only run crossed either cadence threshold. */
  matched: boolean;
  /**
   * Minutes spanned by the FINAL (possibly still-open) tool-only run, from
   * that run's own start to the last tool call actually observed in it.
   * Always 0 when that run has no tool calls (nothing to measure) — never
   * extended by time elapsed after the turn ended.
   */
  gapMinutes: number;
  /** Count of tool_use blocks in the FINAL run since the last assistant TEXT output (reset on each TEXT line). */
  toolCallCount: number;
  /** Whether ANY assistant text appeared anywhere in the turn. */
  hadTextInTurn: boolean;
}

/**
 * Walk `turnLines` in order, splitting them into runs of consecutive
 * tool_use blocks bounded by assistant TEXT lines. A TEXT line both ends the
 * current run (evaluated against the cadence thresholds before it resets)
 * and starts a new one at that line's own timestamp — mirroring the
 * discipline-layer rule that narrating resets the silent-stretch clock.
 *
 * `matched` is true iff ANY run in the turn (not just the trailing one)
 * crosses a threshold — so an early genuine stretch is not masked by a
 * short, harmless trailing run. Each run's span is bounded to timestamps
 * that actually occur WITHIN the turn: a run's start is the prior TEXT
 * line's timestamp (or `turnStartTimestamp` as a fallback when no TEXT has
 * occurred yet in the turn) and its end is the LAST TOOL CALL observed in
 * that run — never a timestamp from a later prompt (mt#3027; see this
 * file's header comment for the incident this structurally forecloses). A
 * run with zero tool calls is never a match candidate, which makes the
 * `hadTextInTurn: true, toolCallCount: 0` false-positive shape structurally
 * impossible rather than merely filtered.
 *
 * The returned `gapMinutes`/`toolCallCount` describe the run that actually
 * MATCHED (the most severe one, when more than one run crosses a
 * threshold) — never an unrelated trailing run. This matters for
 * calibration-log triage (PR #2166 review): reporting the FINAL run's stats
 * unconditionally would let a genuine early-run match surface as
 * `toolCallCount: 0` whenever the turn later closes on more narration with
 * nothing after it — reintroducing the exact `hadTextInTurn: true` +
 * `toolCallCount: 0` shape operators were told marks a false positive, even
 * though `matched` was correctly `true`. When NO run matches, the returned
 * stats describe the final run instead (even if 0/small), preserving the
 * "what did the trailing activity look like" reporting contract callers
 * already rely on for the non-matching case.
 *
 * Reuses `extractAssistantText`/`extractToolUseNames` (both already handle
 * the tool_result-is-user-role hazard and the string-vs-content-array
 * shapes) per-line rather than re-implementing text/tool-use extraction —
 * see this file's header comment.
 */
export function measureSilentStretch(
  turnLines: TranscriptLine[],
  turnStartTimestamp: string | undefined
): SilentStretchMeasurement {
  let hadTextInTurn = false;
  let matched = false;
  let reportedToolCallCount = 0;
  let reportedGapMinutes = 0;

  // Bounds of the CURRENT (possibly still-open) tool-only run.
  let runStartTimestamp = turnStartTimestamp;
  let runToolCallCount = 0;
  let runLastToolTimestamp: string | undefined;

  const evaluateRun = (): void => {
    if (runToolCallCount === 0) return;
    const gapMinutes = computeGapMinutes(runStartTimestamp, runLastToolTimestamp);
    const crosses = gapMinutes >= GAP_MINUTES_THRESHOLD || runToolCallCount >= TOOL_CALL_THRESHOLD;
    if (!crosses) return;
    matched = true;
    // Keep the most severe matching run's stats — a `matched: true` record
    // must always carry evidence of WHY, never the shape of a smaller
    // unrelated run that happened to run last.
    if (runToolCallCount > reportedToolCallCount || gapMinutes > reportedGapMinutes) {
      reportedToolCallCount = runToolCallCount;
      reportedGapMinutes = gapMinutes;
    }
  };

  for (const line of turnLines) {
    const text = extractAssistantText([line]);
    if (text.trim().length > 0) {
      hadTextInTurn = true;
      evaluateRun();
      // A new run starts at this narration — the tool-only clock resets.
      runStartTimestamp = line.timestamp ?? runStartTimestamp;
      runToolCallCount = 0;
      runLastToolTimestamp = undefined;
      continue;
    }
    const toolNames = extractToolUseNames([line]);
    if (toolNames.length > 0) {
      runToolCallCount += toolNames.length;
      runLastToolTimestamp = line.timestamp ?? runLastToolTimestamp;
    }
  }

  evaluateRun();

  if (!matched) {
    // Nothing crossed a threshold — report the FINAL run's own stats (even
    // when 0/small) so callers can still see what the trailing activity
    // looked like.
    reportedToolCallCount = runToolCallCount;
    reportedGapMinutes = computeGapMinutes(runStartTimestamp, runLastToolTimestamp);
  }

  return {
    matched,
    gapMinutes: reportedGapMinutes,
    toolCallCount: reportedToolCallCount,
    hadTextInTurn,
  };
}

/**
 * Minutes between two ISO-8601 timestamps, clamped to >= 0. Returns 0 when
 * either timestamp is missing or unparsable — a missing baseline must never
 * manufacture a spurious large gap.
 */
function computeGapMinutes(from: string | undefined, to: string | undefined): number {
  if (!from || !to) return 0;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return 0;
  return Math.max(0, (toMs - fromMs) / 60000);
}

// ---------------------------------------------------------------------------
// Turn-boundary timestamp lookup
// ---------------------------------------------------------------------------

export interface TurnBoundaryTimestamps {
  /** Timestamp of the PREVIOUS real user prompt (the turn's start boundary). */
  turnStartTimestamp: string | undefined;
  /** Timestamp of the CURRENT real user prompt (the turn's end boundary — the prompt that just fired this hook). */
  currentPromptTimestamp: string | undefined;
}

/**
 * Locate the two real-prompt boundary LINES `extractLastAssistantTurn`
 * slices BETWEEN (exclusive of both), and return their timestamps. Needed
 * because the turn-slice itself never includes the boundary prompts.
 */
export function findTurnBoundaryTimestamps(lines: TranscriptLine[]): TurnBoundaryTimestamps {
  const indices = findRealPromptIndices(lines);
  if (indices.length < 2) {
    return { turnStartTimestamp: undefined, currentPromptTimestamp: undefined };
  }
  const startIdx = indices[indices.length - 2] as number;
  const endIdx = indices[indices.length - 1] as number;
  return {
    turnStartTimestamp: lines[startIdx]?.timestamp,
    currentPromptTimestamp: lines[endIdx]?.timestamp,
  };
}

/**
 * Stable per-session dedupe key identifying WHICH turn was measured — the
 * pair of real-prompt boundary timestamps `extractLastAssistantTurn` sliced
 * between (mt#3003). Two firings that resolve to the SAME anchor pair
 * measured the identical turn (deterministically the identical result), so
 * the second is a stale re-log, not a new signal — this is the shape the
 * cross-transcript-contamination bug produced (see
 * `resolveParentTranscriptLines`'s doc comment in `transcript.ts` for the
 * mechanism). Returns undefined when either boundary is missing (an edge
 * case already excluded upstream by `measureSilentStretch` needing 2 real
 * prompts to produce turnLines at all, but defensive here too) — a record
 * with no anchor is never treated as a dedupe candidate, so it always logs.
 */
export function buildTurnAnchor(boundaries: TurnBoundaryTimestamps): string | undefined {
  if (!boundaries.turnStartTimestamp || !boundaries.currentPromptTimestamp) return undefined;
  return `${boundaries.turnStartTimestamp}::${boundaries.currentPromptTimestamp}`;
}

// ---------------------------------------------------------------------------
// Calibration logging (standalone CLI path only — dispatcher path uses D4
// `logCalibrationRecord` via the registry's `calibrationLog` wiring)
// ---------------------------------------------------------------------------

function appendCalibrationRecord(cwd: string, record: Record<string, unknown>): void {
  try {
    // mt#2710: resolve the actual repo ROOT, not the raw shell cwd — `cwd` is
    // routinely a repo subdirectory, and a bare `resolve(cwd, ...)` would
    // scatter this calibration log into a stray subdirectory `.minsky/`.
    const logPath = resolve(findRepoRoot(cwd), CALIBRATION_LOG);
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[silent-stretch-detector] Failed to write calibration log: ${msg}\n`);
  }
}

/**
 * Real on-disk read of the calibration log's bounded tail, resolved against
 * the repo root (never throws). Thin wrapper over the shared `transcript.ts`
 * `readLogTailText` (mt#3003) — mirrors wall-of-text-detector.ts's own
 * `readCalibrationLogText`, which this file previously had no equivalent of
 * (it had no dedupe check at all before this task).
 */
function readCalibrationLogText(cwd: string): string | undefined {
  const logPath = resolve(findRepoRoot(cwd), CALIBRATION_LOG);
  return readLogTailText(logPath);
}

/** Injectable overrides for `run()` — tests substitute in-memory fakes for both real-IO seams (`custom/no-real-fs-in-tests`). */
export interface RunDeps {
  /** Defaults to the real `parseTranscript`. Used by `resolveParentTranscriptLines`'s multi-candidate branch. */
  parseTranscriptFn?: (path: string) => TranscriptLine[];
  /** Defaults to the real `readCalibrationLogText`. Used by the dedupe check. */
  readCalibrationLogTextFn?: (cwd: string) => string | undefined;
}

// ---------------------------------------------------------------------------
// Dispatcher-compatible pure function (ADR-028 D1/D2)
// ---------------------------------------------------------------------------

/**
 * Guard-dispatcher entry point. Uses `resolveParentTranscriptLines` (mt#3003)
 * instead of trusting `ctx.transcriptLines` (D6) as-is — when this
 * conversation has dispatched subagents, `ctx.transcriptLines` is a flat
 * concatenation of the parent transcript with every sibling subagent
 * transcript (mt#2637), and turn-boundary extraction over that flattened
 * array can anchor inside a SUBAGENT's own (static) transcript instead of
 * the live parent conversation — freezing the measured turn and re-logging
 * the identical record on every subsequent firing (the actual root cause of
 * the "stale turn re-measurement" bug; see `transcript.ts`'s
 * `resolveParentTranscriptLines` doc comment for the full mechanism and the
 * investigation that found it). Before logging, also checks the
 * `buildTurnAnchor` dedupe key (defense-in-depth per the mt#3003 spec) so a
 * turn already logged for this session — anchoring bug aside — is never
 * re-logged. Only calibration logging happens here (via the returned
 * `calibration` field, which the dispatcher forwards to
 * `logCalibrationRecord` per this guard's `calibrationLog: "silent-stretch"`
 * registration) — `additionalContext` is never set while `INJECTION_ENABLED`
 * is false.
 */
export function run(
  input: ClaudeHookInput,
  ctx: DispatchContext,
  deps: RunDeps = {}
): GuardOutcome | null {
  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  const isOverride =
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes";
  if (isOverride) {
    return {
      auditLines: [
        `[silent-stretch-detector] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${new Date().toISOString()}\n`,
      ],
    };
  }

  if (!input.transcript_path) return null;
  const parseTranscriptFn = deps.parseTranscriptFn ?? parseTranscript;
  const readCalibrationLogTextFn = deps.readCalibrationLogTextFn ?? readCalibrationLogText;

  const lines = resolveParentTranscriptLines(
    input.transcript_path,
    ctx.transcriptCandidates,
    ctx.transcriptLines,
    parseTranscriptFn
  );
  if (lines.length === 0) return null;

  let turnLines: TranscriptLine[];
  try {
    turnLines = extractLastAssistantTurn(lines);
  } catch {
    return null;
  }
  if (turnLines.length === 0) return null;

  let measurement: SilentStretchMeasurement;
  let boundaries: TurnBoundaryTimestamps;
  try {
    boundaries = findTurnBoundaryTimestamps(lines);
    measurement = measureSilentStretch(turnLines, boundaries.turnStartTimestamp);
  } catch (err) {
    process.stderr.write(
      `[silent-stretch-detector] Measurement error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return null;
  }

  if (!measurement.matched) return null;

  const turnAnchor = buildTurnAnchor(boundaries);
  if (
    turnAnchor &&
    sessionHasLoggedKey(
      readCalibrationLogTextFn(input.cwd),
      input.session_id,
      "turnAnchor",
      turnAnchor
    )
  ) {
    // mt#3003 defense-in-depth: a record for this exact turn anchor already
    // exists for this session — the anchoring fix above should make this
    // rare, but a genuinely-unchanged re-measurement (or a residual
    // contamination shape not yet covered) must still not re-log.
    return null;
  }

  const outcome: GuardOutcome = {
    calibration: {
      timestamp: new Date().toISOString(),
      session_id: input.session_id,
      gapMinutes: Math.round(measurement.gapMinutes * 100) / 100,
      toolCallCount: measurement.toolCallCount,
      hadTextInTurn: measurement.hadTextInTurn,
      turnAnchor,
    },
  };

  if (INJECTION_ENABLED) {
    // v1 never reaches here — kept structurally symmetric with sibling
    // calibration-first detectors (e.g. causal-premise-detector.ts) so
    // flipping the flag later is a one-line change plus a reminder-text
    // helper, not a restructure.
    outcome.additionalContext = buildInjectionReminder(measurement);
  }

  return outcome;
}

function buildInjectionReminder(measurement: SilentStretchMeasurement): string {
  return [
    "[silent-stretch-detector] Silent tool-only stretch detected (mt#2824).",
    "",
    `The prior turn ran ${measurement.toolCallCount} consecutive tool call(s) and/or ` +
      `${measurement.gapMinutes.toFixed(1)} minute(s) of wall-clock silence without a ` +
      "user-visible status update.",
    "",
    "Emit a one-line heartbeat (current activity + health signal) at least every 10",
    "minutes or 15 tool calls during research/build chains.",
    "",
    `Override: ${OVERRIDE_ENV_VAR}=1.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Standalone CLI entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const capInfo = readHostCap("silent-stretch-detector.ts", undefined, {
    events: ["UserPromptSubmit"],
  });
  if (capInfo.warning) {
    process.stderr.write(`[silent-stretch-detector] ${capInfo.warning}\n`);
  }
  const budgets = deriveBudgets(capInfo.hostCapSec);
  const overallDeadline = Date.now() + budgets.overallBudgetMs;

  const overrideVal = process.env[OVERRIDE_ENV_VAR];
  const isOverride =
    overrideVal === "1" ||
    overrideVal?.toLowerCase() === "true" ||
    overrideVal?.toLowerCase() === "yes";

  let input: ClaudeHookInput;
  try {
    input = await readInput<ClaudeHookInput>();
  } catch {
    process.exit(0);
  }

  if (isOverride) {
    const ts = new Date().toISOString();
    process.stdout.write(
      `[silent-stretch-detector] OVERRIDE: ack=${overrideVal} session=${input.session_id ?? "unknown"} ts=${ts}\n`
    );
    process.exit(0);
  }

  const transcriptPath = input.transcript_path;
  if (!transcriptPath) {
    process.exit(0);
  }

  if (Date.now() >= overallDeadline) {
    process.stderr.write(
      `[silent-stretch-detector] budget exhausted before transcript read — skipping\n`
    );
    process.exit(0);
  }

  // PR #2175 R1: mirrors run()'s cross-transcript-contamination guard
  // (resolveParentTranscriptLines) — a bare parseTranscript(transcriptPath)
  // here would leave the standalone CLI path vulnerable to the same
  // stale-turn freeze the dispatcher path is guarded against, and
  // divergent from it besides.
  const lines = resolveParentTranscriptLinesForPath(transcriptPath, input.agent_id);
  if (lines.length === 0) {
    process.exit(0);
  }

  let turnLines: TranscriptLine[];
  try {
    turnLines = extractLastAssistantTurn(lines);
  } catch {
    process.exit(0);
  }

  if (turnLines.length === 0) {
    process.exit(0);
  }

  let measurement: SilentStretchMeasurement;
  let boundaries: TurnBoundaryTimestamps;
  try {
    boundaries = findTurnBoundaryTimestamps(lines);
    measurement = measureSilentStretch(turnLines, boundaries.turnStartTimestamp);
  } catch (err) {
    console.error(
      `[silent-stretch-detector] Measurement error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(0);
  }

  if (!measurement.matched) {
    process.exit(0);
  }

  const turnAnchor = buildTurnAnchor(boundaries);
  if (Date.now() < overallDeadline) {
    // mt#3003: skip re-logging a turn already recorded for this session
    // (see run()'s equivalent check + this file's header comment).
    const alreadyLogged = turnAnchor
      ? sessionHasLoggedKey(
          readCalibrationLogText(input.cwd),
          input.session_id,
          "turnAnchor",
          turnAnchor
        )
      : false;
    if (!alreadyLogged) {
      appendCalibrationRecord(input.cwd, {
        timestamp: new Date().toISOString(),
        session_id: input.session_id,
        gapMinutes: Math.round(measurement.gapMinutes * 100) / 100,
        toolCallCount: measurement.toolCallCount,
        hadTextInTurn: measurement.hadTextInTurn,
        turnAnchor,
      });
    }
  }

  if (!INJECTION_ENABLED) {
    process.exit(0);
  }

  const reminder = buildInjectionReminder(measurement);
  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: reminder,
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

// Entrypoint guard: only run main() when this file is invoked as a script —
// the dispatcher's dynamic `import("./silent-stretch-detector")` must NOT
// trigger it (mt#2835 — see auto-session-title.ts's header comment for the
// incident this convention prevents: an ungated module-level main() call
// re-entered an already-drained stdin and killed the whole dispatcher
// process mid-loop).
if (import.meta.main) {
  await main();
}

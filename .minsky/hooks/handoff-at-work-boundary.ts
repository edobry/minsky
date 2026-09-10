#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// Handoff-at-work-boundary (mt#5042) — PostToolUse, LOG-ONLY.
//
// Auto-compaction fires when the context window FILLS. That is a resource
// trigger, and it has two costs a work-boundary trigger would not have.
//
// It fires at the point of MAXIMUM RE-UPLOAD. Per `docs/context-bandwidth.md` a
// result emitted at request i of an N-request session is re-sent (N - i) times,
// so everything read before a compaction was re-transmitted on every request up
// to the moment it fired. Compacting at the ceiling means paying the entire tail
// before getting any relief.
//
// It fires MID-NARRATIVE. Heap exhaustion is a fine GC trigger because objects
// have no narrative; a conversation does. A compaction landing mid-action must
// summarize a hypothesis stack it is still inside, where one landing after a
// merge is summarizing residue whose conclusions are already in git, the PR, and
// the task record.
//
// So this records fill AT A WORK BOUNDARY — a merge, a PR landing, a task
// closeout — which is where a handoff would be cheap and lossless.
//
// ---------------------------------------------------------------------------
// WHAT THIS ADDS OVER `context-fill-gauge` — a CONJUNCTION, not a restatement
// ---------------------------------------------------------------------------
//
// `context-fill-gauge.ts` (mt#4291) already reads fill every turn and reports
// it. This guard reuses its measurement wholesale (`measureFill`) and adds one
// thing: the reading is taken only at a BOUNDARY. That is not a cosmetic
// difference, because the two triggers require DIFFERENT THRESHOLDS, and the
// reason is structural rather than a matter of tuning.
//
// A fill-only trigger may fire on ANY turn, so it can afford to wait until 950K
// — there is always another turn. A boundary trigger may fire only AT a
// boundary, and boundaries are SPARSE: measured over 2,644 boundary events
// across 605 local sessions, a 950K threshold catches 8 of the 135 boundaries
// that actually preceded a compaction, missing 94% of them, because by the time
// fill reaches 950K the last boundary has usually already gone by.
//
// The conjunction that makes the trigger land at a clean narrative point is
// therefore the same conjunction that forces it to fire EARLIER. mt#2531's
// thresholds cannot simply be inherited here.
//
// ---------------------------------------------------------------------------
// THE THRESHOLD IS A HYPOTHESIS, NOT A MEASUREMENT
// ---------------------------------------------------------------------------
//
// Measured fill at a boundary: p10 330K, p25 415K, p50 542K, p75 694K, p90 811K.
// Fire rate and recall trade against each other across the plausible band:
//
//   600K -> fires at 40.3% of boundaries, catches 84 of 135 pre-compaction ones
//   650K -> fires at 32.1%, catches 75 of 135, a median 95 requests earlier
//   800K -> fires at 11.2%, catches 36 of 135
//   950K -> fires at  0.7%, catches  8 of 135
//
// A NOTE ON THE POPULATION, because it moved the numbers by a third (PR #3702
// R1). These count only boundaries whose tool call SUCCEEDED, matching what the
// hook fires on — a denied or failed merge never reaches PostToolUse at all. In
// a guard-dense repo that exclusion is large: 3,863 raw boundary events become
// 2,644, and merges alone drop 38%. The mt#5042 planning pass and mt#2531 both
// measured the WIDER population; `--include-failed` reproduces it, and doing so
// reproduces their figures to within rounding (merge p50 542,135 against 542K),
// which is what validates this instrument against the only external check it has.
//
// `DEFAULT_BOUNDARY_FILL_TOKENS` is 650_000: it sits BETWEEN two measured points
// and nothing more. Do NOT cite it as a derived value — this sentence exists so
// a successor does not. Log-only mode is precisely how to price the trade before
// choosing, and the live threshold is the principal's call with a measured fire
// rate in hand.
//
// ---------------------------------------------------------------------------
// WHY LOG-ONLY, AND WHY `ADR-024` IS NOT THE AUTHORITY FOR IT
// ---------------------------------------------------------------------------
//
// mt#5042's SC4 says "calibration-first per ADR-024". The posture is right and
// the authority is wrong. ADR-024's amendment (mt#4595) fixes the test: "the
// matched surface is a closed vocabulary -> out of family; the matched surface
// is prose -> in family." This guard's matched surface is a NUMERIC COMPARISON
// — fill against a threshold — which has no paraphrase axis, so ADR-024 does not
// govern it. `context-fill-gauge.ts` records exactly this for its own sibling
// signal ("a numeric comparison with no paraphrase axis, so it is Rung-1 by
// construction and never climbs").
//
// Log-only here is the repo-wide observer convention (`hook-observers.mdc`) plus
// one specific reason: the threshold is the least-grounded thing in this module,
// and a trigger that ends conversations at a wrong threshold is expensive to
// discover. So v1 RECORDS and does nothing else — no injection, no handoff, no
// successor dispatched, no session stopped.
//
// ---------------------------------------------------------------------------
// AN `ESTIMATED` READING NEVER DRIVES (SC3)
// ---------------------------------------------------------------------------
//
// `resolveWindow` falls back to a 200K assumed window for any model absent from
// `KNOWN_MODEL_WINDOWS`, and that fallback produces a NUMBER rather than an
// error — so the reading looks ordinary. mt#4968 is the incident: a real
// conversation at 308,060 tokens was reported as 154% of a 200K window it had
// never been near, and the figure was relayed to the principal as fact.
//
// A `fallback-default` reading is therefore recorded but can never FIRE. It is
// kept in the stream (rather than dropped) because dropping it would punch a
// hole in the distribution indistinguishable from "this boundary had no usage
// record" — the same reasoning `context-fill-gauge`'s override branch applies.
//
// ---------------------------------------------------------------------------
// DOES NOT COVER (SC5)
// ---------------------------------------------------------------------------
//
//   - A conversation that never reaches a work boundary. A long research or
//     planning session with no merge, PR landing, or closeout gets no boundary
//     and this never fires. mt#2531's fill-only CRITICAL is the backstop for
//     that population, and auto-compaction is the floor beneath both. The two
//     triggers are complements; neither subsumes the other.
//   - A conversation whose context is consumed before its FIRST boundary.
//     Measured p10 fill at merge is 345K, so early merges do exist — but a
//     session that burns the window before merging anything has no boundary to
//     fire at. Same backstop.
//   - Whether the handoff, once written, is any good. This decides WHEN one
//     would be warranted, never what it contains (that is `/handoff`'s, and
//     mt#5043 governs what survives compaction).
//   - Subagent mid-flight fill. Unchanged from mt#2531 §Does NOT cover —
//     nothing about a running subagent's fill is knowable by anyone today.
//   - The inline-lifecycle habit that caused the originating incident.
//     `subagent-routing.mdc §Bandwidth` states the rule and nothing detects the
//     violation; still unowned.
//
// @see mt#5042 — this guard
// @see mt#2531 — the RFC that owns the mechanism, the signal, and the
//      `work-completion.mdc` category-(c) amendment (deliberately NOT landed
//      here: v1 acts on nothing, so there is nothing to authorize yet)
// @see context-fill-gauge.ts — the measurement this reuses rather than re-derives
// @see scripts/measure-context-at-merge.ts — the instrument the figures above
//      came from, and the one to re-run when re-deriving the threshold
// ---------------------------------------------------------------------------

import { readInput, writeOutput, readTunedThreshold } from "./types";
import type { ToolHookInput } from "./types";
import { parseTranscript } from "./transcript";
import type { TranscriptLine } from "./transcript";
import { measureFill } from "./context-fill-gauge";
import type { FillMeasurement } from "./context-fill-gauge";
import { logCalibrationRecord, logEvaluationRecord } from "./dispatcher";

export const GUARD_NAME = "handoff-at-work-boundary";

/**
 * ONE base name for BOTH streams (PR #3702 R1).
 *
 * `logCalibrationRecord` and `logEvaluationRecord` append their own suffixes —
 * `-calibration.jsonl` and `-evaluations.jsonl` — so the two files are already
 * distinct on disk and a shared base is what keeps them recognizably a pair.
 * Three separate constants holding the same literal invited the reading that
 * they might one day diverge; they must not, because the ingest manifest joins
 * both streams to this one `guardName`.
 */
export const LOG_NAME = GUARD_NAME;

/**
 * No bespoke `MINSKY_SKIP_*` name, deliberately.
 *
 * ADR-028 D3 (re-confirmed by ask#9323) makes `MINSKY_HOOK_OVERRIDE` the
 * canonical channel and the per-guard `MINSKY_*` population — 34 -> 99 since the
 * ADR was accepted — the growth it exists to stop. A LOG-ONLY surface has no
 * decision to bypass in any case, which is the same reasoning mt#4493's
 * consumer-account surface shipped on. Use
 * `MINSKY_HOOK_OVERRIDE=handoff-at-work-boundary`.
 */
const HOOK_OVERRIDE_ENV_VAR = "MINSKY_HOOK_OVERRIDE";

/**
 * The pre-registered boundary threshold, in TOKENS.
 *
 * Absolute rather than a ratio — unlike `context-fill-gauge`'s WARN/CRITICAL,
 * which are ratios because the denominator varies per model. Two reasons this
 * one is absolute: the measurement it comes from is absolute (fill at merge, in
 * tokens), and every entry in `KNOWN_MODEL_WINDOWS` today is a 1M window, so
 * against a measured window the two formulations currently agree (650K = 65%).
 *
 * The failure direction if a SMALLER known window is ever added is safe rather
 * than silent-wrong: 650K is unreachable on a 200K window (the harness compacts
 * long before), so this guard would simply never fire for that model instead of
 * firing at a nonsense ratio. `handoff-at-work-boundary.test.ts` pins that
 * expectation so the choice is revisited deliberately rather than discovered.
 */
export const DEFAULT_BOUNDARY_FILL_TOKENS = 650_000;

export const BOUNDARY_FILL_TOKENS_ENV_VAR = "MINSKY_HANDOFF_BOUNDARY_FILL_TOKENS";

/**
 * The three work boundaries mt#5042 names: a merge, a PR landing, a closeout.
 *
 * A closeout is a `tasks_status_set` to DONE specifically — every other status
 * transition is ordinary mid-work motion, not a point at which a conversation's
 * conclusions have landed in durable records.
 */
export type BoundaryKind = "merge" | "pr-landing" | "closeout";

const CLOSEOUT_STATUS = "DONE";

export const BOUNDARY_TOOLS: Readonly<Record<string, BoundaryKind>> = Object.freeze({
  mcp__minsky__session_pr_merge: "merge",
  mcp__github__merge_pull_request: "merge",
  mcp__minsky__session_pr_create: "pr-landing",
  mcp__minsky__tasks_status_set: "closeout",
});

/** Whether a `MINSKY_HOOK_OVERRIDE` value names this guard (or `"all"`). */
export function overrideValueNamesThisGuard(raw: string | undefined): boolean {
  if (!raw) return false;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .some((name) => name === "all" || name === GUARD_NAME);
}

export function isOverridden(env: Record<string, string | undefined>): boolean {
  return overrideValueNamesThisGuard(env[HOOK_OVERRIDE_ENV_VAR]);
}

/**
 * `false` ONLY when the tool result says so explicitly.
 *
 * A failed merge is not a boundary, so an explicit `success: false` disqualifies
 * the call. An ABSENT `success` field is treated as a boundary and recorded with
 * `toolSucceeded: null`: not every tool on the list returns this repo's envelope
 * (`mcp__github__merge_pull_request` is GitHub's shape, not ours), and reading an
 * absent field as failure would silently drop a whole tool's boundaries from the
 * distribution — the class of miss `claim-confidence.mdc` calls a projection over
 * a key the source lacks. Recorded rather than assumed, so a calibration reader
 * can filter on it.
 */
export function readToolSucceeded(input: ToolHookInput): boolean | null {
  const value = input.tool_result?.["success"];
  return typeof value === "boolean" ? value : null;
}

export function resolveRequestedStatus(input: ToolHookInput): string | null {
  const requested = input.tool_input?.["status"];
  if (typeof requested === "string" && requested.length > 0) return requested.toUpperCase();
  const applied = (input.tool_result as Record<string, unknown> | undefined)?.["newStatus"];
  return typeof applied === "string" && applied.length > 0 ? applied.toUpperCase() : null;
}

/**
 * Which boundary this tool call is, or null when it is not one.
 *
 * Returns null for a `tasks_status_set` to anything but DONE, and for an
 * explicitly-failed call.
 */
export function classifyBoundary(input: ToolHookInput): BoundaryKind | null {
  const kind = BOUNDARY_TOOLS[input.tool_name];
  if (kind === undefined) return null;
  if (readToolSucceeded(input) === false) return null;
  if (kind === "closeout" && resolveRequestedStatus(input) !== CLOSEOUT_STATUS) return null;
  return kind;
}

export interface BoundaryReading {
  boundary: BoundaryKind;
  fill: FillMeasurement;
  thresholdTokens: number;
  /** SC3: a `fallback-default` window is ESTIMATED and must never drive the trigger. */
  driveable: boolean;
  /** What v1 would have done, had it been authorized to act. */
  wouldTrigger: boolean;
  toolSucceeded: boolean | null;
}

export function readBoundaryThreshold(
  env: Record<string, string | undefined> = process.env
): number {
  return readTunedThreshold(BOUNDARY_FILL_TOKENS_ENV_VAR, DEFAULT_BOUNDARY_FILL_TOKENS, { env });
}

/**
 * The decision, with the transcript injected. Returns null when this call is not
 * a boundary at all, or when no usage record is resolvable (the ordinary
 * first-turn state — fail open, record nothing).
 */
export function decideBoundaryReading(
  input: ToolHookInput,
  lines: readonly TranscriptLine[],
  thresholdTokens: number
): BoundaryReading | null {
  const boundary = classifyBoundary(input);
  if (boundary === null) return null;

  const fill = measureFill(lines);
  if (fill === null) return null;

  const driveable = fill.windowSource === "known-model";
  return {
    boundary,
    fill,
    thresholdTokens,
    driveable,
    wouldTrigger: driveable && fill.fillTokens >= thresholdTokens,
    toolSucceeded: readToolSucceeded(input),
  };
}

export interface RunDeps {
  parseTranscriptFn?: typeof parseTranscript;
  logCalibrationRecordFn?: typeof logCalibrationRecord;
  logEvaluationRecordFn?: typeof logEvaluationRecord;
  env?: Record<string, string | undefined>;
}

/**
 * Records EVERY boundary, not only the ones over threshold.
 *
 * A fire-only stream can say "it happened again" and can never say "it stopped
 * happening" (mt#3583) — and here the non-firing rows are the more valuable
 * half: they ARE the fill-at-boundary distribution this threshold has to be
 * re-derived from. The evaluation stream carries all of them; the calibration
 * stream carries the would-fire subset a review actually reads.
 */
export function run(input: ToolHookInput, deps: RunDeps = {}): BoundaryReading | null {
  const env = deps.env ?? process.env;
  if (isOverridden(env)) return null;
  if (BOUNDARY_TOOLS[input.tool_name] === undefined) return null;
  if (!input.transcript_path) return null;

  const parse = deps.parseTranscriptFn ?? parseTranscript;
  const logEvaluation = deps.logEvaluationRecordFn ?? logEvaluationRecord;
  const logCalibration = deps.logCalibrationRecordFn ?? logCalibrationRecord;

  const lines = parse(input.transcript_path);
  if (lines.length === 0) return null;

  const reading = decideBoundaryReading(input, lines, readBoundaryThreshold(env));
  if (reading === null) return null;

  const row = {
    timestamp: new Date().toISOString(),
    session_id: input.session_id ?? null,
    guardName: GUARD_NAME,
    boundary: reading.boundary,
    toolName: input.tool_name,
    toolSucceeded: reading.toolSucceeded,
    fillTokens: reading.fill.fillTokens,
    windowTokens: reading.fill.windowTokens,
    windowSource: reading.fill.windowSource,
    ...(reading.fill.windowMatchedKey !== undefined
      ? { windowMatchedKey: reading.fill.windowMatchedKey }
      : {}),
    fillRatioPct: reading.fill.fillRatioPct,
    assistantTurnCount: reading.fill.assistantTurnCount,
    ...(reading.fill.model !== undefined ? { model: reading.fill.model } : {}),
    thresholdTokens: reading.thresholdTokens,
    driveable: reading.driveable,
    fired: reading.wouldTrigger,
  };

  logEvaluation(LOG_NAME, row, { fallbackCwd: input.cwd });
  if (reading.wouldTrigger) logCalibration(LOG_NAME, row);

  return reading;
}

async function main(): Promise<void> {
  const input = (await readInput()) as ToolHookInput;
  run(input);
  // LOG-ONLY: never denies, never injects, never acts.
  writeOutput({});
}

if (import.meta.main) {
  void main();
}

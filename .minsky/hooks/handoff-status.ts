// Shared predicate: does a `tasks_status_set` call in this turn count as taking
// the work FORWARD? (mt#4228)
//
// Both stop-at-handoff guards had `mcp__minsky__tasks_status_set` in their
// forward-motion set, UNQUALIFIED by which status was set —
// `stop-at-decision-scan.ts`'s `DISCHARGE_TOOLS` and
// `turn-end-unwalked-task-scan.ts`'s `WALK_FORWARD_TOOLS`. That is right for
// most transitions and inverts for exactly two.
//
// PLANNING and READY are the statuses whose entire meaning is "the next skill
// should now run". A turn that sets one and stops has not walked the task; it
// has OPENED a hand-off. So the single call that most reliably marks the
// canonical stop-at-handoff was the one both guards read as evidence the step
// had been taken.
//
// Measured before the change (`.minsky/stop-at-decision-evaluations.jsonl`,
// 596 records, 23 fired, 385 carrying a candidate task): a suppression set
// containing `tasks_status_set` accounted for 192 of those 385 — half of every
// turn the detector had something to say about.
//
// Declared ONCE and imported by both, rather than hand-mirrored into each: two
// copies of a predicate whose whole job is to agree is the drift shape this
// repo has been bitten by before (mt#3586; the `MENU_SHAPE_LEGS` note in
// `ask-routing-deferral-detector.ts` makes the same argument for the same
// reason).
//
// @see mt#4228 — this module; mem#610 R6 — the incident
// @see .minsky/hooks/stop-at-decision-scan.ts — DISCHARGE_TOOLS consumer
// @see .minsky/hooks/turn-end-unwalked-task-scan.ts — WALK_FORWARD_TOOLS consumer

/** The tool whose `status` argument this module interprets. */
export const STATUS_SET_TOOL = "mcp__minsky__tasks_status_set";

/**
 * The statuses that OPEN a hand-off rather than closing one.
 *
 * Both are states whose definition is "a skill should now pick this up":
 * `/plan-task` owns PLANNING, `/implement-task` owns READY. Every other status
 * — IN-PROGRESS, IN-REVIEW, DONE, BLOCKED, CLOSED — either IS the next step
 * being taken or is a terminal/blocked state with nothing to walk to, so each
 * of those genuinely is forward motion.
 */
export const HANDOFF_STATUSES: ReadonlySet<string> = new Set(["PLANNING", "READY"]);

/**
 * Does the `status` argument of ONE `tasks_status_set` call count as forward
 * motion?
 *
 * **Fails OPEN by construction.** A `status` this cannot parse — absent, not a
 * string, or a value outside the known set — returns `true`, so the call keeps
 * the forward-motion reading it had before this module existed. The failure
 * this guards against is a MISSED fire (an advisory that does not appear);
 * failing the other way would manufacture fires out of unreadable input, which
 * is strictly worse for a detector whose calibration data is the thing being
 * protected.
 */
export function statusSetIsForwardMotion(input: Record<string, unknown>): boolean {
  const status = input["status"];
  if (typeof status !== "string") return true;
  const normalized = status.trim().toUpperCase();
  if (normalized.length === 0) return true;
  return !HANDOFF_STATUSES.has(normalized);
}

/**
 * Across every `tasks_status_set` call in a turn, does ANY of them take the
 * work forward?
 *
 * ANY rather than ALL: a turn that sets one task to PLANNING and another to
 * IN-PROGRESS did move something forward, and suppressing on the PLANNING call
 * alone would silence a turn that genuinely acted. The narrow case this
 * changes is the turn whose ONLY status transitions open hand-offs.
 *
 * Returns `false` when there are no calls at all — "no forward motion from this
 * tool", which is what both callers want, since neither treats an absent call
 * as evidence of anything.
 */
export function anyStatusSetIsForwardMotion(inputs: readonly Record<string, unknown>[]): boolean {
  return inputs.some(statusSetIsForwardMotion);
}

/**
 * A hand-off status named anywhere in a CLI command string.
 *
 * Only ever applied to a command ALREADY confirmed to be a
 * `tasks status set` invocation, which is what makes a bare word match safe:
 * within that command the status is the only place `PLANNING` or `READY`
 * plausibly appears, whether spelled positionally
 * (`minsky tasks status set mt#1 READY`) or as a flag (`--status READY`).
 */
const HANDOFF_STATUS_IN_COMMAND_RE = /\b(?:PLANNING|READY)\b/i;

/**
 * The CLI-transport half of {@link statusSetIsForwardMotion}.
 *
 * Both transports are qualified deliberately. mt#3730 shipped after R5 recurred
 * on the CLI path that the MCP-keyed guard could not see, and its lesson was
 * that enforcement must key on the CAPABILITY across every transport reaching
 * it. Qualifying only the MCP path here would rebuild that exact asymmetry one
 * level down — the guard would correctly decline to discharge on an MCP
 * `→ PLANNING` and still discharge on the identical CLI command.
 *
 * Fails OPEN like its sibling: a status-set command naming no recognizable
 * hand-off status reads as forward motion.
 */
export function cliStatusSetIsForwardMotion(command: string): boolean {
  return !HANDOFF_STATUS_IN_COMMAND_RE.test(command);
}

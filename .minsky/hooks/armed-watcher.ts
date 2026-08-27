// Shared predicate: did this turn leave a wait RUNNING past its own end? (mt#4327)
//
// `work-completion.mdc §External self-resolving waits` splits turn-end "blocked"
// in two. Blocked on a principal decision -> stop and escalate. Blocked on an
// external, self-resolving condition -> "arm a background watcher and keep
// going", closing with something like "I've armed a 30s background poll and will
// resume on recovery, no action needed from you."
//
// That second shape is COMPLIANCE, and to a guard that keys on "nothing was
// minted and the turn ended" it is indistinguishable from a stop — a turn
// waiting on a background run has nothing to mint YET, so it is not at a
// decision, ripe or otherwise. `turn-end-untaken-action-scan.ts` already
// suppressed on this evidence; `stop-at-decision-scan.ts` did not, and fired
// hardest at exactly the behaviour the rule exists to produce (mt#4327:
// roughly 7 of the 13 fires in the 2026-08-19 06:02Z window).
//
// Keyed on TOOL-CALL STATE rather than on the closing message's wording. The
// prose forms — "watcher armed", "waiting on", "will notify" — are a paraphrase
// surface, and matching them would put this predicate on ADR-024's ladder,
// which is the arms race the structured alternative exists to avoid.
//
// Declared ONCE and imported by both, rather than hand-mirrored into each: the
// tool list IS the discriminator, so a copy that gains an entry while the other
// does not silently reinstates the false positive, with no test to catch it —
// the drift class mt#4330 exists to flag. Same argument, and the same shape, as
// `handoff-status.ts` (mt#4228).
//
// @see mt#4327 — this module
// @see .minsky/hooks/turn-end-untaken-action-scan.ts — original home, consumer
// @see .minsky/hooks/stop-at-decision-scan.ts — consumer added by mt#4327
// @see .minsky/hooks/handoff-status.ts — the sibling shared predicate

import { extractToolUseNames, findToolUseInputs } from "./transcript";

/**
 * Tool calls that ARE an armed wait, rather than prose claiming one (mt#4063).
 *
 * ## Why this is not another phrase pattern
 *
 * This guard's armed-watcher suppression has now been widened twice on the
 * language axis — mt#3917 added it, mt#3948 unbound it from one word order —
 * and the 2026-08-12 calibration window produced three MORE phrasings that
 * escape both patterns: `watch` where the noun set has `watcher`/`wait`, an
 * intervening `for it` between the noun and its copula, and `is polling`, which
 * carries no `armed` token at all and so is unreachable by any widening of the
 * `armed` patterns.
 *
 * That is the precondition the patterns' own ADR-024 placement note set: "If a
 * THIRD distinct armed-watcher phrasing is filed against this set, that is the
 * measured insufficiency of Rung 1 for this family and the next pass raises the
 * rung rather than the pattern count." Three arrived at once.
 *
 * The rung this raises to is not Rung 2 (embedding). Whether a watcher was
 * armed is not a language question at all — it is a fact about the turn's tool
 * calls, and reading it directly REMOVES the paraphrase axis instead of buying
 * better recall along it. A cheaper deterministic signal outranking a costlier
 * probabilistic one is the outcome ADR-024's ladder exists to produce.
 *
 * ## What counts
 *
 * Only calls that actually leave something running. `session_pr_checks` is
 * listed but gated on `wait: true` below, because without it the call is a
 * one-shot snapshot read and no watcher survives it — the same distinction
 * `work-completion.mdc §External self-resolving waits` draws between arming a
 * watcher and merely looking once.
 *
 * Deliberately NOT bought: naming a blocker. "I'll merge when the review lands"
 * with no wait armed still fires, exactly as the phrase patterns intended — the
 * evidence here is the tool call, so prose cannot manufacture it.
 *
 * ## Keeping this set current (PR #2972 R1)
 *
 * The set is hand-maintained, so a new blocking-wait tool added elsewhere does
 * not appear here on its own. There is no registry of "tools that leave
 * something running" to derive it from — blocking-ness is a property of each
 * tool's semantics, not of anything declared — so a parity assertion has
 * nothing to assert against.
 *
 * What IS asserted is the set's exact contents (`ARMED_WAIT_TOOLS` is exported
 * for that test alone). Adding or removing a member fails that test, which
 * makes drift a deliberate edit with a visible diff rather than a silent one.
 * The failure mode this leaves open is a NEW wait tool nobody adds here — it
 * shows up as this guard firing on a correctly-armed turn, which is the same
 * signal the calibration log already surfaces, and the same way the three
 * phrasings in this docblock were found.
 */
export const ARMED_WAIT_TOOLS = new Set([
  "ScheduleWakeup",
  "Monitor",
  "mcp__minsky__session_pr_wait-for-review",
  "mcp__minsky__deployment_wait-for-latest",
  "mcp__minsky__asks_wait-for-response",
  "mcp__minsky__pr_watch_run",
  "mcp__minsky__reviewer_watch_run",
]);

/** `session_pr_checks` is a watcher only when it was asked to wait. */
export const CONDITIONAL_WAIT_TOOL = "mcp__minsky__session_pr_checks";

/**
 * Tool-call evidence that a wait is running past the end of this turn.
 *
 * Returns the evidence found — most useful for the calibration record, which is
 * why callers should write it whether or not it suppressed. An empty array means
 * the turn armed nothing.
 */
export function detectArmedWatcherEvidence(
  turnLines: Parameters<typeof findToolUseInputs>[0]
): string[] {
  const evidence = new Set<string>();

  for (const name of extractToolUseNames(turnLines)) {
    if (ARMED_WAIT_TOOLS.has(name)) evidence.add(name);
  }

  for (const input of findToolUseInputs(turnLines, CONDITIONAL_WAIT_TOOL)) {
    if (input["wait"] === true) {
      evidence.add(CONDITIONAL_WAIT_TOOL);
      break;
    }
  }

  for (const input of findToolUseInputs(turnLines, "Bash")) {
    if (input["run_in_background"] === true) {
      evidence.add("Bash(run_in_background)");
      break;
    }
  }

  // SORTED, and that matters downstream (PR #3402 R1): `stop-at-decision-scan`
  // renders this into a `armed-watcher:<a,b>` suppression reason, and calibration
  // review GROUPS records by that string. Insertion order here follows the turn's
  // tool order, so two turns arming the same pair in opposite orders would produce
  // two distinct reason strings for one phenomenon and split the group. Sorting at
  // the source rather than at the one call site that noticed keeps every consumer
  // deterministic — the sibling writes this array into its calibration record too.
  return [...evidence].sort();
}

/**
 * authorship-judging-flag — the default-OFF switch for merge-time AI
 * authorship-tier judging (mt#3101).
 *
 * Why this exists. Until mt#3101 the judging block was unreachable by
 * accident: it looked transcripts up under a workspace id against the
 * conversation keyspace, so the lookup always returned null. Measured
 * 2026-07-23 — 0 of 1,305 `provenance` rows resolve, and exactly 1 has ever
 * been judged. Repairing the lookup alone would therefore have SWITCHED THE
 * FEATURE ON: every session PR merge would begin making an Anthropic
 * completion call over the full transcript and writing a tier to PR labels and
 * merge trailers.
 *
 * The operator declined that (ask#5581, 2026-07-23: "fix the lookup, leave
 * judging off"), so the repair ships with this explicit gate. Turning judging
 * on is now a deliberate act rather than a side effect of a bug fix.
 *
 * Default is OFF for the un-set and unrecognized cases alike — a typo'd value
 * must not enable a feature that costs money per merge.
 *
 * @see mt#3101 — this file; the id-space repair it gates
 * @see ask#5581 — the operator decision it encodes
 */

/**
 * Env var controlling merge-time judging. Registered in `HOOK_ONLY_ENV_VARS`
 * (`configuration/sources/environment.ts`) — not because a hook reads it, but
 * because that set is the registry for `MINSKY_*` vars with NO config-schema
 * home: without an entry, the loader's auto-mapping fallback would route this
 * to a bogus `authorship.tierJudging` path and mt#1612 strict-mode validation
 * would reject it, crashing the CLI whenever the var is set.
 */
export const AUTHORSHIP_TIER_JUDGING_ENV_VAR = "MINSKY_AUTHORSHIP_TIER_JUDGING";

/** The single value that turns judging on. Anything else leaves it off. */
export const AUTHORSHIP_TIER_JUDGING_ENABLED_VALUE = "enabled";

/**
 * Whether merge-time AI authorship-tier judging should run.
 *
 * Reads the environment on every call rather than caching, so a long-lived MCP
 * server picks the flag up without a restart.
 */
export function isAuthorshipTierJudgingEnabled(): boolean {
  return process.env[AUTHORSHIP_TIER_JUDGING_ENV_VAR] === AUTHORSHIP_TIER_JUDGING_ENABLED_VALUE;
}

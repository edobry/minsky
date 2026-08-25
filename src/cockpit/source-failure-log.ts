/**
 * The `error` / `message` field for a cockpit off-request cache failure (mt#4597).
 *
 * ## Why this exists rather than `err.message`
 *
 * The four caches that populate the cockpit's off-request snapshots
 * (`interceptor-aggregates-cache`, `topology-cache`, `prod-state-cache`,
 * `short-id-map-cache`) each guard their reads and log the failure. All of them
 * logged `err instanceof Error ? err.message : String(err)`, and for a drizzle
 * query that is the WORST available choice: `DrizzleQueryError.message` is
 * built as `Failed query: <sql>\nparams: <params>` and the real driver error is
 * on `.cause` (`drizzle-orm/errors/index.cjs:24-33`). So the log recorded the
 * SQL and every bound parameter, and none of the diagnosis.
 *
 * Measured during the 2026-08-25 degradation window: the canary-history
 * failure's `error` field was **4685 characters** of SELECT text plus 148 bound
 * guard names, with no Postgres error anywhere in it. A statement timeout, a
 * socket severed by `createBoundedSocket`'s inactivity bound, a pooler
 * rejection and a genuine SQL error all rendered identically.
 *
 * `getLoggableErrorSummary` (mt#2903) already solves this — it walks the
 * `.cause` chain and truncates each level INDEPENDENTLY, so the driver error
 * survives no matter how large the wrapper's message is. Its own docblock says
 * to use it "wherever a caught error is written into a log record, ESPECIALLY
 * around database calls." These sites were simply never converted.
 *
 * ## Two functions, because the cap is not one-size-fits-all
 *
 * The aggressive cap below is justified by a property only a QUERY failure has:
 * the wrapper's message is noise because the diagnosis lives on `.cause`.
 * A git subprocess failure or a filesystem write failure has no such wrapper —
 * its message IS the diagnosis (a command's stderr, a long path), and clipping
 * it at 300 characters would destroy information with nothing to fall back on.
 *
 * So pick by what the guarded operation actually is:
 *
 * - {@link describeQueryFailure} — the operation is a database query, so a
 *   drizzle wrapper is the expected failure. Small cap.
 * - {@link describeSourceFailure} — anything else (subprocess, filesystem,
 *   parsing, or a catch-all spanning both). Domain default cap.
 *
 * Reviewer-caught on PR #3359 R1: the first version applied the small cap
 * everywhere, including `topology-cache`'s `execFile("git", …)` catch and both
 * caches' `atomicWriteJSON` catches.
 */
import { getLoggableErrorSummary, MAX_LOGGED_ERROR_CHARS } from "@minsky/domain/errors/index";

/**
 * Per-cause-level character cap for a QUERY failure.
 *
 * Well below `MAX_LOGGED_ERROR_CHARS` (2000) on purpose. At a query site the
 * drizzle wrapper's message is pure noise — the source label logged alongside
 * it (`"canary history"`, `"fire-log lifetime"`, the `table` field) already
 * identifies which query failed, so the SQL text buys nothing a reader needs.
 * 300 characters is enough to see the statement's shape if anyone wants it, and
 * comfortably clears a Postgres error message: the longest realistic ones here
 * — `canceling statement due to statement timeout`, `Connection terminated
 * unexpectedly`, `unable to check out connection from the pool after 60000ms`
 * — are all under 80 characters, so the level carrying the diagnosis is never
 * the level that gets clipped.
 *
 * Applied to the measured 4685-character case this yields roughly 615
 * characters WITH the cause, against 4685 without it.
 */
export const QUERY_FAILURE_ERROR_CHARS = 300;

/**
 * Render a caught DATABASE-QUERY failure for a log record.
 *
 * Use at a site whose guarded operation is a query, where a `DrizzleQueryError`
 * (or an equivalent wrapper carrying the statement in its message) is the
 * expected failure.
 */
export function describeQueryFailure(err: unknown): string {
  return getLoggableErrorSummary(err, QUERY_FAILURE_ERROR_CHARS);
}

/**
 * Render any OTHER caught cache failure for a log record.
 *
 * Still cause-bearing — a subprocess or filesystem error can chain too, and
 * that is the half `err.message` was dropping — but at the domain's default
 * cap, because here the top-level message is the diagnosis rather than a
 * wrapper around it.
 *
 * The explicit `MAX_LOGGED_ERROR_CHARS` argument is redundant with the helper's
 * own default and is passed anyway: it makes the contrast with
 * {@link describeQueryFailure} visible at a glance, so the next reader sees two
 * deliberate choices rather than one choice and one omission.
 */
export function describeSourceFailure(err: unknown): string {
  return getLoggableErrorSummary(err, MAX_LOGGED_ERROR_CHARS);
}

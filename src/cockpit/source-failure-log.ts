/**
 * The `error` field for a cockpit off-request source-read failure (mt#4597).
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
 * around database calls." These four sites were simply never converted.
 */
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

/**
 * Per-cause-level character cap for a source-read failure.
 *
 * Well below `MAX_LOGGED_ERROR_CHARS` (2000) on purpose. At these sites the
 * drizzle wrapper's message is pure noise — the source label passed alongside
 * it (`"canary history"`, `"fire-log lifetime"`) already identifies which query
 * failed, so the SQL text buys nothing a reader needs. 300 characters is enough
 * to see the statement's shape if anyone wants it, and comfortably clears a
 * Postgres error message: the longest realistic ones here — `canceling
 * statement due to statement timeout`, `Connection terminated unexpectedly`,
 * `unable to check out connection from the pool after 60000ms` — are all under
 * 80 characters, so the level that carries the diagnosis is never the level
 * that gets clipped.
 *
 * Applied to the measured 4685-character case this yields roughly 615
 * characters WITH the cause, against 4685 without it.
 */
export const SOURCE_FAILURE_ERROR_CHARS = 300;

/**
 * Render a caught source-read failure for a log record's `error` field.
 *
 * Exported (rather than inlined at each call site) so the cap above has one
 * definition across the four caches, and so the site's own contract — cause
 * present, wrapper clipped — is assertable without spying on the logger.
 */
export function describeSourceFailure(err: unknown): string {
  return getLoggableErrorSummary(err, SOURCE_FAILURE_ERROR_CHARS);
}

import { log } from "../../utils/logger";

/**
 * Shared `onnotice` handler for postgres-js clients (mt#1828).
 *
 * postgres-js emits Postgres NOTICE messages (e.g., drizzle's
 * `CREATE SCHEMA IF NOT EXISTS drizzle` and `CREATE TABLE IF NOT EXISTS
 * __drizzle_migrations` produce codes 42P06 / 42P07 on every cold start) to a
 * caller-supplied handler. The library's default writes them to stdout, which
 * pollutes the CLI's data channel (mt#1827).
 *
 * Pre-mt#1828, every site that wired this handler used `() => {}`. That kept
 * stdout clean but dropped potentially-useful operational signals on the floor
 * (per PR #1108 R1 NB#3). This helper routes NOTICEs through `log.debug` so
 * they're observable when an operator turns up log verbosity, while keeping
 * stdout untouched.
 *
 * Defensive contract: this function MUST NOT throw — postgres-js invokes it
 * inside its own error-handling and a thrown exception would surface as a
 * client-side disconnect rather than the original NOTICE.
 */
export function logPostgresNotice(notice: unknown): void {
  try {
    if (!notice || typeof notice !== "object") {
      log.debug("postgres notice (non-object payload)", { raw: String(notice) });
      return;
    }
    const n = notice as Record<string, unknown>;
    const message = typeof n.message === "string" ? n.message : String(n.message ?? "");
    log.debug(`postgres notice: ${message}`, {
      severity: typeof n.severity === "string" ? n.severity : undefined,
      code: typeof n.code === "string" ? n.code : undefined,
      routine: typeof n.routine === "string" ? n.routine : undefined,
    });
  } catch {
    // Never propagate failures back to the postgres client.
  }
}

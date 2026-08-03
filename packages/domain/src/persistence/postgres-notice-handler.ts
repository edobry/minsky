import { log } from "@minsky/shared/logger";

/** A single structured debug log entry, described independent of WHERE it's emitted. */
export interface NoticeLogEntry {
  message: string;
  context: Record<string, unknown>;
}

/**
 * Pure decision core (mt#3628): build the debug log entry for a Postgres
 * NOTICE payload — routes a non-object payload through a diagnostic-prefix
 * message + raw string context, and a well-formed notice through a
 * `postgres notice: <message>` message + structured severity/code/routine
 * context. No I/O, no logger — testable entirely by return value.
 */
export function describeNotice(notice: unknown): NoticeLogEntry {
  if (!notice || typeof notice !== "object") {
    return { message: "postgres notice (non-object payload)", context: { raw: String(notice) } };
  }
  const n = notice as Record<string, unknown>;
  const message = typeof n.message === "string" ? n.message : String(n.message ?? "");
  return {
    message: `postgres notice: ${message}`,
    context: {
      severity: typeof n.severity === "string" ? n.severity : undefined,
      code: typeof n.code === "string" ? n.code : undefined,
      routine: typeof n.routine === "string" ? n.routine : undefined,
    },
  };
}

/** Injectable debug sink for logPostgresNotice (mt#3628). */
export interface LogPostgresNoticeDeps {
  debug: (message: string, meta?: Record<string, unknown>) => void;
}

const defaultLogPostgresNoticeDeps: LogPostgresNoticeDeps = { debug: log.debug };

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
export function logPostgresNotice(
  notice: unknown,
  deps: LogPostgresNoticeDeps = defaultLogPostgresNoticeDeps
): void {
  try {
    const entry = describeNotice(notice);
    deps.debug(entry.message, entry.context);
  } catch {
    // Never propagate failures back to the postgres client.
  }
}

/**
 * Shared presence-claim activity-freshness lookup (mt#3086 origin; extracted
 * in mt#3172).
 *
 * `tasks.dispatch-recover`'s on-demand healthy-classification staleness check
 * (mt#3086) and the dispatch-watchdog PRODUCER's periodic sweep
 * (`src/cockpit/dispatch-watchdog.ts`, mt#3172) both need to know "how
 * recently did an MCP tool call touch this Minsky session" — the same
 * question, against the same `presence_claims` table, keyed the same way
 * (`subject_kind = "session"`). Before this extraction each site carried its
 * own independently-written copy of the query; this module is the single
 * source of truth both consult, so a future fix to the freshness lookup (or
 * its fail-open/logging posture) lands once, not twice.
 *
 * See `computeDispatchStaleness`'s docstring
 * (`@minsky/domain/session/dispatch-recovery-classifier`) for the full
 * rationale on why `presence_claims` — not the harness transcript JSONL mtime
 * — is the signal consulted here, and for the documented residual blind spot
 * (a dispatch making literally zero Minsky-MCP-routed tool calls for an
 * entire stale window stays invisible to this signal, same as to commits).
 *
 * Fail-open throughout: no persistence provider, no `getDatabaseConnection`,
 * no live connection, no repository, or a query failure all resolve to
 * `null` rather than throwing — this signal is best-effort, matching the
 * rest of the presence-claims write/read path's posture
 * (`src/mcp/server.ts`'s `writeSessionAttachment`, `tasks.claims.list`).
 *
 * @see mt#3086 — original single-consumer implementation (tasks.dispatch-recover)
 * @see mt#3172 — this extraction (adds the dispatch-watchdog producer as a second consumer)
 * @see docs/architecture/presence-claims.md — the presence-claim subsystem this borrows
 */
import { log } from "@minsky/shared/logger";
import { getLoggableErrorSummary } from "../errors/index";

/**
 * The minimal provider shape this lookup needs — a `getDatabaseConnection`
 * accessor returning a Drizzle-compatible connection (or `undefined`/`null`
 * when unavailable). Deliberately narrower than the full
 * `SqlCapablePersistenceProvider` interface so callers can pass whatever
 * provider-shaped value they already have without an awkward cast.
 */
export interface PresenceActivityProvider {
  getDatabaseConnection?: () => Promise<unknown>;
}

/** Identifies the calling site in log lines so a shared-helper failure is traceable to its origin. */
export interface PresenceActivityLogContext {
  /** Short caller tag, e.g. "tasks.dispatch-recover" or "dispatch-watchdog". */
  source: string;
}

/**
 * Resolve the ms-epoch timestamp of the freshest `presence_claims` refresh
 * for the given Minsky session (`subject_kind = "session"`), or `null` when
 * unavailable (no persistence provider, no DB connection, no claim ever
 * written for this session, or `subjectId` itself is null/empty).
 *
 * The threshold argument presence-claims normally carries (its own 15-minute
 * TTL annotation) is irrelevant here — callers read the raw timestamp and
 * apply their OWN staleness math against it, so this always requests the
 * full history via `Number.MAX_SAFE_INTEGER` and relies on `listClaims`
 * ordering desc by `lastRefreshedAt` (the first row is already the
 * freshest).
 */
export async function resolveLastPresenceActivityAtMs(
  subjectId: string | null,
  provider: PresenceActivityProvider | null | undefined,
  logContext: PresenceActivityLogContext
): Promise<number | null> {
  if (!subjectId) return null;

  try {
    if (!provider?.getDatabaseConnection) {
      // A persistence-less CLI/test context is a routine, expected shape,
      // not an operational anomaly — debug, not warn.
      log.debug(
        `[${logContext.source}] resolveLastPresenceActivityAtMs: no persistence provider / ` +
          "getDatabaseConnection — presence signal unavailable",
        { subjectId }
      );
      return null;
    }
    const db = await provider.getDatabaseConnection();
    if (!db) {
      log.debug(
        `[${logContext.source}] resolveLastPresenceActivityAtMs: getDatabaseConnection() ` +
          "resolved no connection — presence signal unavailable",
        { subjectId }
      );
      return null;
    }
    const { buildPresenceClaimRepository } = await import("../presence/index");
    const repo = buildPresenceClaimRepository(db);
    if (!repo) {
      log.debug(
        `[${logContext.source}] resolveLastPresenceActivityAtMs: buildPresenceClaimRepository ` +
          "returned null — presence signal unavailable",
        { subjectId }
      );
      return null;
    }
    const claims = await repo.listClaims("session", subjectId, Number.MAX_SAFE_INTEGER);
    const freshest = claims[0]?.lastRefreshedAt;
    if (!freshest) return null;
    const ms = Date.parse(freshest);
    return Number.isFinite(ms) ? ms : null;
  } catch (err) {
    // Reaching here means resolution STARTED (a provider/db/repo existed)
    // and then threw — a DI-wiring break, an unexpected dynamic-import
    // shape, or a real query failure. That is an operational anomaly worth
    // surfacing, not a silent degrade — warn, not debug.
    log.warn(
      `[${logContext.source}] resolveLastPresenceActivityAtMs resolution failed unexpectedly ` +
        "(degrading to no presence signal)",
      { subjectId, error: getLoggableErrorSummary(err) }
    );
    return null;
  }
}

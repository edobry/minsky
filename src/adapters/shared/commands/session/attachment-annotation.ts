/**
 * Attached/detached annotation for `session list` / `session get` (mt#2284).
 *
 * Best-effort: annotates session records with an `attached: boolean` field
 * derived from the LIVE (pid-liveness-confirmed) session-grain presence-claim
 * set — `listLiveSessionAttachments`, NOT the raw stored claim set. A stored
 * claim row alone is not proof of current liveness (the reaper may not have
 * run yet since a hard-killed harness), so this deliberately re-checks pid
 * liveness rather than trusting row-presence — see
 * `packages/domain/src/session/attachment.ts`'s `isAttachmentConfirmedLive`
 * doc comment. Never throws — when persistence is unavailable or the read
 * fails, sessions are returned with `attached` left unset rather than
 * blocking the underlying list/get command. This indicator is visually and
 * semantically distinct from the existing activity-derived `liveness` field
 * (see cli-result-formatters.ts's separate glyph for it).
 */
import { log } from "@minsky/shared/logger";
import type {
  PersistenceProvider,
  SqlCapablePersistenceProvider,
} from "@minsky/domain/persistence/types";

async function buildAttachedSessionIdSet(
  getPersistenceProvider?: () => PersistenceProvider | undefined
): Promise<Set<string> | null> {
  const provider = getPersistenceProvider?.();
  const sqlProvider = provider as SqlCapablePersistenceProvider | undefined;
  if (!sqlProvider?.getDatabaseConnection) return null;

  try {
    const db = await sqlProvider.getDatabaseConnection();
    if (!db) return null;

    const { buildPresenceClaimRepository } = await import("@minsky/domain/presence/index");
    const repo = buildPresenceClaimRepository(db);
    if (!repo) return null;

    const { listLiveSessionAttachments } = await import("@minsky/domain/session/index");
    const liveAttachments = await listLiveSessionAttachments(repo);
    return new Set(liveAttachments.map((a) => a.sessionId));
  } catch (err) {
    log.debug("[session attachment annotation] Failed to resolve stored attachments", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Annotate a list of session records with `attached: boolean`. Returns the
 * input unmodified (no `attached` field added) when the attachment set could
 * not be resolved — callers should treat a missing `attached` field as
 * "unknown", not "detached".
 */
export async function annotateSessionsWithAttachment<T extends { sessionId?: string }>(
  sessions: T[],
  getPersistenceProvider?: () => PersistenceProvider | undefined
): Promise<Array<T & { attached?: boolean }>> {
  const attachedIds = await buildAttachedSessionIdSet(getPersistenceProvider);
  if (!attachedIds) return sessions;

  return sessions.map((session) => ({
    ...session,
    attached: session.sessionId ? attachedIds.has(session.sessionId) : false,
  }));
}

/**
 * Annotate a single session record with `attached: boolean`. Same
 * unknown-vs-detached distinction as the list variant.
 */
export async function annotateSessionWithAttachment<T extends { sessionId?: string }>(
  session: T,
  getPersistenceProvider?: () => PersistenceProvider | undefined
): Promise<T & { attached?: boolean }> {
  const annotated = await annotateSessionsWithAttachment([session], getPersistenceProvider);
  return annotated[0] ?? session;
}

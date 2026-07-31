/**
 * Session runtime-attachment (presence) domain layer (mt#2284).
 *
 * Session-workspace grain of the mt#2562 presence/claim substrate:
 * `subject_kind = "session"`, `subject_id` = the Minsky workspace session id.
 * This is a distinct axis from `agentId` (last-touched-by identity, mt#1078)
 * and `deriveSessionLiveness` (activity recency, mt#951) — see the task spec's
 * "Distinct from existing mechanisms" section.
 *
 * `registeredAt` in the domain type below maps onto the presence-claim row's
 * `lastRefreshedAt` — "repeated activity refreshes registeredAt rather than
 * appending duplicates" is exactly the claim table's existing upsert-on-conflict
 * semantics (unique on subjectKind/subjectId/actorId).
 */

import { hostname } from "node:os";
import type { PresenceClaimRepository, PresenceClaim } from "../presence/index";

/** A single runtime attachment to a session workspace. */
export interface SessionAttachment {
  id: string;
  sessionId: string;
  /** The attaching actor's resolved identity (agentId, or a pid-based fallback). */
  actorId: string;
  pid?: number;
  tty?: string;
  host?: string;
  ccConversationId?: string;
  entrypoint?: string;
  terminalContext?: Record<string, string>;
  /** When this attachment was first registered, or last refreshed by activity. */
  registeredAt: string; // ISO-8601
}

function toSessionAttachment(claim: PresenceClaim): SessionAttachment {
  return {
    id: claim.id,
    sessionId: claim.subjectId,
    actorId: claim.actorId,
    pid: claim.pid,
    tty: claim.tty,
    host: claim.host,
    ccConversationId: claim.ccConversationId,
    entrypoint: claim.entrypoint,
    terminalContext: claim.terminalContext,
    registeredAt: claim.lastRefreshedAt,
  };
}

/** List stored attachments for one session. */
export async function listSessionAttachments(
  repo: PresenceClaimRepository,
  sessionId: string
): Promise<SessionAttachment[]> {
  const claims = await repo.listClaims("session", sessionId);
  return claims.map(toSessionAttachment);
}

/** List stored attachments across ALL sessions (used by `session ps` and the reaper). */
export async function listAllSessionAttachments(
  repo: PresenceClaimRepository
): Promise<SessionAttachment[]> {
  const claims = await repo.listAllForKind("session");
  return claims.map(toSessionAttachment);
}

/**
 * Teardown: clear every attachment record for a session (mt#2284 — called on
 * session merge/cleanup so no dangling attachment survives the session).
 * Returns the count of deleted rows.
 */
export async function clearSessionAttachments(
  repo: PresenceClaimRepository,
  sessionId: string
): Promise<number> {
  return repo.deleteBySubject("session", sessionId);
}

/**
 * Check whether a local pid is still alive. Never throws.
 *
 * Shells out to `kill -0 <pid>` via `Bun.spawnSync` (project convention —
 * `node:child_process` is restricted; see `bun_over_node.mdc`; this also
 * sidesteps this repo's legacy ambient `process` shim, `src/types/node.d.ts`,
 * which omits `process.kill`). `kill -0` sends no signal but performs the
 * existence check: exit code 0 means the pid exists and is signalable by us;
 * non-zero means it is dead OR owned by another user. For self-registered
 * session attachments (always our own process), that distinction collapses —
 * non-zero is treated as dead.
 */
export function isPidAlive(pid: number): boolean {
  try {
    const result = Bun.spawnSync(["kill", "-0", String(pid)]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Whether a stored attachment is CONFIRMED live right now (mt#2284 R1 review
 * fix). A stored claim row is a fact about the past ("this actor registered
 * at time T"), not proof of current liveness — a hard-killed harness leaves
 * the row in place until the reaper runs. Consumers that render a
 * point-in-time "is this attached NOW" indicator (the `session list`/`get`
 * glyph) must not treat row-presence alone as "attached"; they should use
 * this predicate (or `listLiveSessionAttachments` below), not raw
 * `listAllSessionAttachments`/`listSessionAttachments`.
 *
 * Local-host only (v0, same scope as the reaper): a remote-host claim (future
 * cross-host case) cannot be liveness-checked here and is conservatively
 * treated as NOT confirmed live, rather than trusting an unverifiable row.
 */
export function isAttachmentConfirmedLive(
  attachment: Pick<SessionAttachment, "host" | "pid">,
  localHost: string = hostname()
): boolean {
  if (attachment.host && attachment.host !== localHost) return false;
  if (typeof attachment.pid !== "number") return false;
  return isPidAlive(attachment.pid);
}

/**
 * List only the attachments confirmed live right now (local-host pid-liveness
 * check applied) — the correct source for a live "attached" indicator, as
 * opposed to `listAllSessionAttachments`/`listSessionAttachments`, which
 * return the raw stored (possibly stale) claim set.
 */
export async function listLiveSessionAttachments(
  repo: PresenceClaimRepository,
  sessionId?: string
): Promise<SessionAttachment[]> {
  const all = sessionId
    ? await listSessionAttachments(repo, sessionId)
    : await listAllSessionAttachments(repo);
  const localHost = hostname();
  return all.filter((a) => isAttachmentConfirmedLive(a, localHost));
}

export interface ReapStaleAttachmentsResult {
  reapedIds: string[];
  reapedCount: number;
  /** Attachments registered from a non-local host — skipped, not reaped (v0 scope). */
  skippedRemoteHostCount: number;
}

/**
 * Stale-attachment reaper (mt#2284).
 *
 * ### Covers
 * - A self-registered attachment whose `pid` is confirmed dead on THIS host
 *   (hard-killed harness/process — the recovery-layer discipline's named case).
 *
 * ### Does NOT cover
 * - Attachments registered from a remote host (`host` != this host's hostname):
 *   skipped and counted separately in `skippedRemoteHostCount`. No pid-liveness
 *   check is possible against a remote host in v0 — cross-host detection is
 *   explicitly out of scope for this task (schema carries `host` for forward
 *   compatibility only). No owner task exists yet for remote-host reaping;
 *   the schema's `host` column is the seam a future cross-host task would use.
 * - Attachments with no recorded `pid` (e.g. malformed/partial writes): left
 *   alone here; the generic TTL-based `reapStale` (mt#2562) is the backstop
 *   for those via `lastRefreshedAt` staleness.
 */
export async function reapStaleSessionAttachments(
  repo: PresenceClaimRepository
): Promise<ReapStaleAttachmentsResult> {
  const localHost = hostname();
  const all = await repo.listAllForKind("session");

  const toReap: string[] = [];
  let skippedRemoteHostCount = 0;

  for (const claim of all) {
    if (claim.host && claim.host !== localHost) {
      skippedRemoteHostCount++;
      continue;
    }
    if (typeof claim.pid !== "number") {
      continue;
    }
    if (!isPidAlive(claim.pid)) {
      toReap.push(claim.id);
    }
  }

  const reapedCount = toReap.length > 0 ? await repo.deleteByIds(toReap) : 0;

  return { reapedIds: toReap, reapedCount, skippedRemoteHostCount };
}

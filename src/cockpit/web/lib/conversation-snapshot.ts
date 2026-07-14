/**
 * Shared conversation-snapshot fetcher + query key (mt#2768 — "One snapshot
 * query key" success criterion).
 *
 * Before mt#2768, `ConversationView` (query key `["conversation", "snapshot", id]`)
 * and `ContextInspector` (query key `["context-inspector", "snapshot", id]`)
 * fetched the SAME underlying endpoint (`GET /api/cockpit/context-inspector/snapshot`)
 * under DIFFERENT query keys — so viewing a run's Conversation tab and then its
 * Context tab double-fetched the same snapshot. Every consumer of the snapshot
 * (`ConversationView`, `ContextBlockView`, any future embed) MUST import
 * `fetchSnapshot`/`snapshotQueryKey` from HERE rather than defining a parallel
 * copy, so TanStack Query's cache dedupes them for free.
 */
import type { SessionContextSnapshot } from "@minsky/domain/context/types";
import type { ConversationId } from "@minsky/domain/ids";

/**
 * Carries the HTTP status AND the structured error `code` so callers can
 * distinguish "no transcript" (404 / `session_not_found`) from a wrong-id-space
 * mistake (422 / `wrong_id_space`, mt#2525) and from real failures.
 */
export class SnapshotError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string
  ) {
    super(message);
    this.name = "SnapshotError";
  }
}

function isSnapshot(value: unknown): value is SessionContextSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { agentSessionId?: unknown }).agentSessionId === "string" &&
    Array.isArray((value as { blocks?: unknown }).blocks)
  );
}

export async function fetchSnapshot(sessionId: ConversationId): Promise<SessionContextSnapshot> {
  const res = await fetch(
    `/api/cockpit/context-inspector/snapshot?sessionId=${encodeURIComponent(sessionId)}`
  );
  if (!res.ok) {
    // The endpoint returns `{ error: { code, message } }`; fall back to the raw
    // body when it isn't that shape (e.g. a proxy/HTML error page).
    const raw = await res.text();
    let code: string | undefined;
    let detail = raw;
    try {
      const parsed = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown } };
      if (parsed.error && typeof parsed.error === "object") {
        if (typeof parsed.error.code === "string") code = parsed.error.code;
        if (typeof parsed.error.message === "string") detail = parsed.error.message;
      }
    } catch {
      // Non-JSON body — keep the raw text as the detail.
    }
    throw new SnapshotError(res.status, code, `Snapshot fetch failed (${res.status}): ${detail}`);
  }
  const json: unknown = await res.json();
  if (!isSnapshot(json)) {
    throw new Error("Snapshot response did not match the expected shape");
  }
  return json;
}

/** The ONE query key every snapshot consumer must share for cache dedup. */
export function snapshotQueryKey(sessionId: ConversationId): readonly [string, string, string] {
  return ["conversation", "snapshot", sessionId] as const;
}

/**
 * Do NOT retry a client error (4xx) — a wrong/unresolvable id will never
 * succeed on retry, and the default TanStack retry policy (3 attempts,
 * exponential backoff) left loading spinners visible for 15+s on a genuinely
 * bad id before the error state finally rendered (mt#2769, observed live
 * 2026-07-13). 5xx/network errors still retry — those CAN be transient.
 */
export function snapshotRetry(failureCount: number, error: Error): boolean {
  const status = error instanceof SnapshotError ? error.status : undefined;
  if (status !== undefined && status >= 400 && status < 500) return false;
  return failureCount < 3;
}

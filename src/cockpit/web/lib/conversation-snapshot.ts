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

/**
 * An opt-in bound on how much of a conversation to fetch (mt#4263).
 *
 * Only the conversation RENDERER wants one. The other three consumers of this
 * endpoint read every block — `ContextBlockView` filters them,
 * `ConversationOverviewPanel` aggregates them, `PublishConversationDialog`
 * publishes them — so they call without a window and keep getting the whole
 * transcript.
 */
export interface SnapshotWindowParams {
  /** Max turns to fetch, counted back from the newest. */
  turns: number;
  /**
   * Page back from this ORIGINAL turn index (exclusive). Omit for the newest
   * page; pass the previous page's `window.nextBefore` to go further back.
   *
   * NOT `window.oldestTurnIndex` — that is the oldest turn RENDERED and is null
   * for a page whose entries were all non-renderable, which ends paging over
   * history that still exists (PR #3148 R1).
   */
  before?: number;
}

function windowSearchParams(window: SnapshotWindowParams | undefined): string {
  if (window === undefined) return "";
  const before = window.before === undefined ? "" : `&before=${window.before}`;
  return `&turns=${window.turns}${before}`;
}

export async function fetchSnapshot(
  sessionId: ConversationId,
  window?: SnapshotWindowParams
): Promise<SessionContextSnapshot> {
  const res = await fetch(
    `/api/cockpit/context-inspector/snapshot?sessionId=${encodeURIComponent(sessionId)}${windowSearchParams(window)}`
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

/**
 * The ONE query key every snapshot consumer must share for cache dedup.
 *
 * Window-aware since mt#4263, and the `turns` suffix is not cosmetic: a windowed
 * and an unwindowed request return DIFFERENT responses for the same
 * conversation, so sharing a key would let whichever landed first serve the
 * other — a full transcript rendered as if it were fifty turns, or fifty turns
 * used as the whole conversation by the three consumers that aggregate over it.
 *
 * The unwindowed key is byte-identical to what mt#2768 established, so those
 * three consumers keep deduping against each other exactly as before. Only
 * `before` is excluded from the key: pages of one conversation accumulate under
 * ONE infinite-query entry rather than becoming a separate cache entry each,
 * which is what lets scroll-back keep everything it has already fetched.
 */
export function snapshotQueryKey(
  sessionId: ConversationId,
  window?: SnapshotWindowParams
): readonly string[] {
  return window === undefined
    ? (["conversation", "snapshot", sessionId] as const)
    : (["conversation", "snapshot", sessionId, `w${window.turns}`] as const);
}

/**
 * Fold windowed pages into the one snapshot the renderer consumes (mt#4263).
 *
 * Pages arrive newest-first (page 0 is the tail, each subsequent page reaches
 * further back), so blocks are concatenated in reverse page order to restore
 * chronological order. Ids are deduped because the newest page's attachment
 * bound is deliberately open at the top, so a live conversation can deliver the
 * same trailing attachment on a refetch.
 *
 * `toolNamesByUseId` is UNIONED across pages rather than taken from one: it is
 * whole-conversation data and identical on every page today, but a union is
 * correct even if a later page is served from a moment when the conversation had
 * grown. Whole-conversation fields (`harness`, spawn links) come from the newest
 * page, which is the one that reflects the conversation's current state.
 */
export function mergeSnapshotPages(
  pages: readonly SessionContextSnapshot[]
): SessionContextSnapshot {
  const newest = pages[0];
  if (newest === undefined) {
    throw new Error("mergeSnapshotPages requires at least one page");
  }
  if (pages.length === 1) return newest;

  const blocks: SessionContextSnapshot["blocks"] = [];
  const seen = new Set<string>();
  const toolNamesByUseId: Record<string, string> = {};

  for (let i = pages.length - 1; i >= 0; i--) {
    const page = pages[i];
    if (page === undefined) continue;
    for (const block of page.blocks) {
      if (seen.has(block.id)) continue;
      seen.add(block.id);
      blocks.push(block);
    }
    Object.assign(toolNamesByUseId, page.toolNamesByUseId ?? {});
  }

  // The pages are already chronological relative to one another, but a page's
  // attachments are merged into it by timestamp — so a re-sort is what keeps the
  // seam between two pages ordered the same way as the middle of one.
  blocks.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return {
    ...newest,
    blocks,
    toolNamesByUseId,
    // The pinned head block is PAGING state, not content (mt#4909) — it stands
    // in for a turn 0 the reader has not fetched — so it travels with
    // `nextBefore` from the oldest page, for the reason spelled out below.
    // Overriding the `...newest` spread is the load-bearing half: once the
    // oldest page reaches index 0 the server stops sending it, and the pin
    // disappears because the real turn is now in `blocks`. That is what keeps
    // the brief from rendering twice, with no client-side de-duplication and
    // nothing to keep in sync.
    headBlock: pages[pages.length - 1]?.headBlock,
    // The OLDEST page's bounds describe the merged whole — taking the newest
    // page's would claim history is unfetched that the reader is already
    // looking at. `nextBefore` and `hasMore` travel together and BOTH come from
    // that page: they are the paging state, and splitting them across pages is
    // the same conflation PR #3148 R1 flagged inside the assembler.
    ...(newest.window
      ? {
          window: {
            ...newest.window,
            returnedTurns: blocks.filter((b) => b.turnIndex !== undefined).length,
            oldestTurnIndex: pages[pages.length - 1]?.window?.oldestTurnIndex ?? null,
            nextBefore: pages[pages.length - 1]?.window?.nextBefore ?? null,
            hasMore: pages[pages.length - 1]?.window?.hasMore ?? false,
          },
        }
      : {}),
  };
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

/**
 * Renderable classification of a failed snapshot fetch (mt#3131 PR #2245 R1
 * hardening). The ONE place the server's error-code/status contract is
 * interpreted — UI components branch on the returned class, never on raw
 * `code === "..."` strings or bare status numbers, so a server-side drift in
 * either dimension has exactly one client-side site to update.
 *
 *   - `"wrong_id_space"` — a Minsky WORKSPACE session id used where a harness
 *     conversation id is required (mt#2525 fail-loud). Matched by code OR by
 *     the 422 status alone (an intermediary/proxy that drops the JSON body
 *     but preserves the status still classifies correctly — reviewer #1729).
 *   - `"invalid_id"` — the id is not even conversation-id-shaped and could
 *     never resolve (mt#3131 D3/D5). Matched by code regardless of status,
 *     so a server-side status change (404 → 400, say) cannot silently
 *     downgrade this to the misleading "may still be running" copy.
 *   - `"not_found"` — a syntactically plausible id with no transcript (yet).
 *     Any OTHER 404 lands here, including an unrecognized future code — the
 *     honest fallback for "the server said the entity doesn't exist."
 *   - `"other"` — everything else (500s, network shapes, non-Snapshot
 *     errors); callers render a generic error state.
 */
export type SnapshotErrorClass = "wrong_id_space" | "invalid_id" | "not_found" | "other";

export function classifySnapshotError(error: Error): SnapshotErrorClass {
  if (!(error instanceof SnapshotError)) return "other";
  if (error.code === "wrong_id_space" || error.status === 422) return "wrong_id_space";
  if (error.code === "invalid_id") return "invalid_id";
  if (error.status === 404) return "not_found";
  return "other";
}

/**
 * useLiveTail / useConversationLiveTail — SPA hooks for the live-tail SSE
 * streams (mt#2232 workspace-keyed; mt#2749 conversation-keyed).
 *
 * Both hooks accumulate `SessionContextSnapshotBlock` objects as they arrive
 * over SSE from their respective endpoints. The accumulated `liveBlocks` are
 * intended to be passed to `ConversationThread` as `extraBlocks` so new turns
 * appear appended to the existing DB snapshot without a full re-fetch.
 *
 * The two hooks share ONE internal implementation (`useSseLiveTail`) — same
 * EventSource lifecycle, same shape guard, same accumulation logic — so the
 * two live-tail channels cannot drift on that shared behavior. Only the URL
 * (and therefore the id-space of the key) differs:
 *
 *   - `useLiveTail(workspaceSessionId)` → `GET /api/agents/:id/live-tail`
 *     (mt#2232). Unchanged public signature/behavior — WorkspaceDetailPage's
 *     existing usage is untouched.
 *   - `useConversationLiveTail(agentSessionId)` → `GET
 *     /api/conversation/:agentSessionId/live-tail` (mt#2749). No workspace
 *     bridge — opens directly off the harness ConversationId.
 *
 * Design notes (both hooks):
 * - Uses the browser's `EventSource` API. Auto-reconnects natively.
 * - Only opens a connection when the id argument is truthy.
 * - Resets accumulation when the id argument changes.
 * - Fail-open: SSE parse errors are silently skipped (the snapshot endpoint
 *   covers the full history; live blocks are supplemental).
 *
 * @see src/cockpit/routes/agents.ts GET /api/agents/:id/live-tail — workspace-keyed endpoint
 * @see src/cockpit/routes/conversations.ts GET /api/conversation/:agentSessionId/live-tail — conversation-keyed endpoint
 * @see src/cockpit/web/widgets/ConversationView.tsx — consumer of both hooks
 * @see mt#2232 — Rung-1 observe→drive ladder (workspace-keyed precursor)
 * @see mt#2749 — conversation-keyed sibling
 */

import { useEffect, useRef, useState } from "react";
import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";
import type { ConversationId, WorkspaceId } from "@minsky/domain/ids";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Connection status reported by the hook. */
export type LiveTailStatus = "idle" | "connecting" | "connected" | "error";

/** Value returned by `useLiveTail` / `useConversationLiveTail`. */
export interface UseLiveTailResult {
  /** New blocks received since the SSE connection was established (append-only). */
  liveBlocks: SessionContextSnapshotBlock[];
  /** Current SSE connection state. */
  status: LiveTailStatus;
}

// ---------------------------------------------------------------------------
// Shape guard
// ---------------------------------------------------------------------------

/**
 * True when a parsed SSE frame is a renderable live block.
 *
 * Keys on `id` only — the field the server ALWAYS synthesizes for a live block
 * (`<agentSessionId>:live:<n>`, see `live-tail-poller.ts` `turnLineToBlock` +
 * the live-id override) and the one `ConversationThread` uses as its React key
 * / dedup anchor. `timestamp` is deliberately NOT required: it drives only
 * display ordering, and dropping an otherwise-valid turn because a JSONL line
 * lacked a timestamp is worse than showing it (live blocks are supplemental +
 * append-only — fail open).
 *
 * Note this is NOT `uuid` or `rawJsonlType`: `uuid` names the RAW JSONL input
 * line (the poller's input, not its output) and `rawJsonlType` names the
 * block's origin-type — neither is the emitted block's identity. The emitted
 * `SessionContextSnapshotBlock` is keyed by `id`, so that is what the guard
 * checks. Exported so the guard's accept/reject contract is unit-pinned
 * against the real emitted shape (mt#2749 review R1).
 */
export function isRenderableLiveBlock(block: unknown): block is SessionContextSnapshotBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    typeof (block as Record<string, unknown>)["id"] === "string"
  );
}

// ---------------------------------------------------------------------------
// Shared implementation — identical EventSource lifecycle for both channels
// ---------------------------------------------------------------------------

/**
 * Subscribe to a live-tail SSE endpoint at `url`. Internal — callers use the
 * id-keyed wrappers below, which build the URL for their respective endpoint
 * and id-space.
 *
 * @param url - Full path to the SSE endpoint, or `null`/`undefined` to stay idle.
 */
function useSseLiveTail(url: string | null | undefined): UseLiveTailResult {
  const [liveBlocks, setLiveBlocks] = useState<SessionContextSnapshotBlock[]>([]);
  const [status, setStatus] = useState<LiveTailStatus>("idle");

  // Keep a ref to the accumulated blocks so the EventSource handler always
  // sees the latest state without needing to be re-registered.
  const blocksRef = useRef<SessionContextSnapshotBlock[]>([]);

  useEffect(() => {
    if (!url) {
      setStatus("idle");
      setLiveBlocks([]);
      blocksRef.current = [];
      return;
    }

    // Reset accumulation for the new URL/session.
    blocksRef.current = [];
    setLiveBlocks([]);
    setStatus("connecting");

    const es = new EventSource(url);

    es.addEventListener("open", () => {
      setStatus("connected");
    });

    es.addEventListener("message", (ev: MessageEvent) => {
      let block: unknown;
      try {
        block = JSON.parse(ev.data as string);
      } catch {
        // Malformed JSON — skip silently
        return;
      }

      // See `isRenderableLiveBlock` for the accept/reject contract.
      if (!isRenderableLiveBlock(block)) {
        return;
      }

      const snapshotBlock = block;
      const next = [...blocksRef.current, snapshotBlock];
      blocksRef.current = next;
      setLiveBlocks(next);
    });

    es.addEventListener("error", () => {
      setStatus("error");
      // EventSource auto-reconnects; status reverts to "connected" on the
      // next successful open event.
    });

    return () => {
      es.close();
      setStatus("idle");
    };
  }, [url]);

  return { liveBlocks, status };
}

// ---------------------------------------------------------------------------
// Public hooks
// ---------------------------------------------------------------------------

/**
 * Subscribe to the workspace-keyed live-tail SSE stream (mt#2232).
 *
 * Pass the returned `liveBlocks` to `ConversationView` as `extraBlocks` to
 * show in-progress turns alongside the existing DB snapshot.
 *
 * @param workspaceSessionId - Minsky workspace sessionId (WorkspaceId).
 *   When falsy, the hook is idle and returns an empty `liveBlocks` array.
 */
export function useLiveTail(workspaceSessionId: WorkspaceId | null | undefined): UseLiveTailResult {
  const url = workspaceSessionId
    ? `/api/agents/${encodeURIComponent(workspaceSessionId)}/live-tail`
    : null;
  return useSseLiveTail(url);
}

/**
 * Subscribe to the conversation-keyed live-tail SSE stream (mt#2749) — no
 * workspace/cwd bridge, keyed directly off the harness `agentSessionId`.
 *
 * @param agentSessionId - Harness ConversationId. When falsy, the hook is
 *   idle and returns an empty `liveBlocks` array.
 */
export function useConversationLiveTail(
  agentSessionId: ConversationId | null | undefined
): UseLiveTailResult {
  const url = agentSessionId
    ? `/api/conversation/${encodeURIComponent(agentSessionId)}/live-tail`
    : null;
  return useSseLiveTail(url);
}

/**
 * useLiveTail — SPA hook for the Rung-1 live-tail SSE stream (mt#2232).
 *
 * Connects to `GET /api/agents/:workspaceSessionId/live-tail` and
 * accumulates `SessionContextSnapshotBlock` objects as they arrive over SSE.
 * The accumulated `liveBlocks` are intended to be passed to `ConversationThread`
 * as `extraBlocks` so new turns appear appended to the existing DB snapshot
 * without a full re-fetch.
 *
 * Design notes:
 * - Uses the browser's `EventSource` API. Auto-reconnects natively.
 * - Only opens a connection when `workspaceSessionId` is truthy.
 * - Resets accumulation when `workspaceSessionId` changes.
 * - Fail-open: SSE parse errors are silently skipped (the snapshot endpoint
 *   covers the full history; live blocks are supplemental).
 *
 * @see src/cockpit/server.ts GET /api/agents/:id/live-tail — server endpoint
 * @see src/cockpit/web/widgets/ConversationView.tsx — consumer
 * @see mt#2232 — Rung-1 observe→drive ladder
 */

import { useEffect, useRef, useState } from "react";
import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";
import type { WorkspaceId } from "@minsky/domain/ids";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Connection status reported by the hook. */
export type LiveTailStatus = "idle" | "connecting" | "connected" | "error";

/** Value returned by `useLiveTail`. */
export interface UseLiveTailResult {
  /** New blocks received since the SSE connection was established (append-only). */
  liveBlocks: SessionContextSnapshotBlock[];
  /** Current SSE connection state. */
  status: LiveTailStatus;
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

/**
 * Subscribe to the live-tail SSE stream for a workspace session.
 *
 * Pass the returned `liveBlocks` to `ConversationView` as `extraBlocks` to
 * show in-progress turns alongside the existing DB snapshot.
 *
 * @param workspaceSessionId - Minsky workspace sessionId (WorkspaceId).
 *   When falsy, the hook is idle and returns an empty `liveBlocks` array.
 */
export function useLiveTail(workspaceSessionId: WorkspaceId | null | undefined): UseLiveTailResult {
  const [liveBlocks, setLiveBlocks] = useState<SessionContextSnapshotBlock[]>([]);
  const [status, setStatus] = useState<LiveTailStatus>("idle");

  // Keep a ref to the accumulated blocks so the EventSource handler always
  // sees the latest state without needing to be re-registered.
  const blocksRef = useRef<SessionContextSnapshotBlock[]>([]);

  useEffect(() => {
    if (!workspaceSessionId) {
      setStatus("idle");
      setLiveBlocks([]);
      blocksRef.current = [];
      return;
    }

    // Reset accumulation for the new session.
    blocksRef.current = [];
    setLiveBlocks([]);
    setStatus("connecting");

    const url = `/api/agents/${encodeURIComponent(workspaceSessionId)}/live-tail`;
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

      // Minimal shape guard: must have `id` (string) and `timestamp` (string).
      if (
        typeof block !== "object" ||
        block === null ||
        typeof (block as Record<string, unknown>)["id"] !== "string" ||
        typeof (block as Record<string, unknown>)["timestamp"] !== "string"
      ) {
        return;
      }

      const snapshotBlock = block as SessionContextSnapshotBlock;
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
  }, [workspaceSessionId]);

  return { liveBlocks, status };
}

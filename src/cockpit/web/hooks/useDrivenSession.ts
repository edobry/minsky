/**
 * useDrivenSession — SPA hook for the mt#2750 driven-session WebSocket channel
 * (mt#2751, Rung 2B).
 *
 * Parallel to `useLiveTail`/`useConversationLiveTail`
 * (`./useLiveTail.ts`) — same "id in, accumulated state out" shape — but
 * drives a bidirectional `WebSocket` (browser API, NOT the `ws` npm package —
 * that's server-side only) rather than a one-way `EventSource`, because a
 * driven session needs operator INPUT (`sendText`/`stop`), not just observed
 * output.
 *
 * Opens `GET /api/driven-session/:id/ws` (cookie-authed same-origin — see
 * `src/cockpit/driven-session-ws.ts`'s docblock; a same-origin SPA connection
 * just works, no token plumbing needed here). Frames received are raw
 * stream-json `event.payload` objects, folded through the pure
 * `foldDrivenSessionEvent` reducer (`../lib/driven-session-accumulator.ts`) —
 * this hook owns ONLY the WebSocket lifecycle and state wiring; all the
 * event-shape knowledge lives in that reducer so it stays independently
 * unit-testable.
 *
 * No Tauri API use (ADR-023) — the browser `WebSocket` constructor works
 * identically in the cockpit-tray webview and a plain browser tab.
 *
 * @see mt#2751 — this module
 * @see mt#2750 — `src/cockpit/driven-session-ws.ts` (server-side wire protocol)
 * @see ../lib/driven-session-accumulator.ts — the pure event-folding reducer
 * @see ../widgets/ConversationView.tsx — consumes `blocks` via the `drivenBlocks` seam
 * @see ./useLiveTail.ts — the Rung-1 SSE sibling this hook parallels
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";
import {
  createInitialDrivenAccumulatorState,
  foldDrivenSessionEvent,
  type DrivenAccumulatorState,
  type DrivenSessionInteractionState,
  type DrivenSessionResultSummary,
} from "../lib/driven-session-accumulator";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Transport-level WebSocket lifecycle — distinct from `status` below, which is the session-run status. */
export type DrivenSessionConnectionState = "connecting" | "open" | "closed" | "error";

/**
 * Unified session status (mt#2751 success criterion 4): "connecting / live /
 * exited (with result summary) / crashed". Derived from BOTH the WS
 * transport state and the accumulator's session-lifecycle `runStatus` — a
 * channel that never opens (auth failure, unknown session id) surfaces as
 * `"crashed"` with a readable `errorMessage` rather than hanging on
 * `"connecting"` forever.
 */
export type DrivenSessionStatus = "connecting" | "live" | "exited" | "crashed";

export interface UseDrivenSessionResult {
  /** Accumulated blocks — feed to `ConversationView`'s `drivenBlocks` prop. */
  blocks: SessionContextSnapshotBlock[];
  /** Unified session status for the status UI (success criterion 4). */
  status: DrivenSessionStatus;
  /** Raw WS transport state — mainly for diagnosing a channel-auth/unknown-session failure. */
  connectionState: DrivenSessionConnectionState;
  /** Composer-facing state (success criterion 3): disable/label the input per this. */
  interactionState: DrivenSessionInteractionState;
  resultSummary: DrivenSessionResultSummary | null;
  errorMessage: string | null;
  harnessSessionId: string | null;
  /** Send operator input as `{"text": ...}` — a no-op if the channel isn't open. */
  sendText: (text: string) => void;
  /** Send `{"type": "stop"}` for a graceful stop — a no-op if the channel isn't open. */
  stop: () => void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Relative URL — the WebSocket constructor resolves a relative `url` against
 * the document's base URL per the WHATWG URL spec (swapping http→ws /
 * https→wss automatically), same as `EventSource`/`fetch` do for the SSE
 * hooks (`./useLiveTail.ts`'s `/api/agents/${id}/live-tail`). No manual
 * protocol/host string-building needed, and it keeps this identical in the
 * cockpit-tray webview and a plain browser tab (ADR-023).
 */
function buildDrivenSessionWsUrl(localId: string): string {
  return `/api/driven-session/${encodeURIComponent(localId)}/ws`;
}

function deriveStatus(
  connectionState: DrivenSessionConnectionState,
  runStatus: DrivenAccumulatorState["runStatus"]
): DrivenSessionStatus {
  if (runStatus === "exited") return "exited";
  if (runStatus === "crashed") return "crashed";
  if (connectionState === "connecting") return "connecting";
  // Channel closed/errored before the session ever reported running — a
  // channel-auth failure or unknown-session-id case (mt#2751 success
  // criterion 4: "a channel auth failure or unknown session renders a
  // readable error").
  if (connectionState === "error" || connectionState === "closed") return "crashed";
  return "live";
}

/**
 * Subscribe to the driven-session WS channel at `localId` (the
 * `DrivenSessionRecord.localId` returned by `POST /api/driven-session`).
 *
 * @param localId - The driven session's local id. When falsy, the hook stays
 *   idle (no connection) and returns empty/initial state.
 */
export function useDrivenSession(localId: string | null | undefined): UseDrivenSessionResult {
  const [connectionState, setConnectionState] =
    useState<DrivenSessionConnectionState>("connecting");
  const [accState, setAccState] = useState<DrivenAccumulatorState>(() =>
    createInitialDrivenAccumulatorState()
  );
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!localId) {
      setConnectionState("closed");
      setAccState(createInitialDrivenAccumulatorState());
      return;
    }

    setConnectionState("connecting");
    setAccState(createInitialDrivenAccumulatorState());

    const ws = new WebSocket(buildDrivenSessionWsUrl(localId));
    wsRef.current = ws;

    const handleOpen = () => setConnectionState("open");
    const handleMessage = (ev: MessageEvent) => {
      // The daemon only ever sends text frames (JSON), but a WebSocket can
      // deliver Blob/ArrayBuffer if binaryType changes — guard explicitly so a
      // non-string frame is skipped rather than coerced into a bogus parse
      // (mt#2751 R1 non-blocking note).
      if (typeof ev.data !== "string") return;
      let payload: unknown;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        return; // malformed frame — fail open, skip (mirrors useLiveTail's posture).
      }
      if (payload === null || typeof payload !== "object") return;
      setAccState((prev) => foldDrivenSessionEvent(prev, payload as Record<string, unknown>));
    };
    const handleError = () => setConnectionState("error");
    const handleClose = () => setConnectionState("closed");

    ws.addEventListener("open", handleOpen);
    ws.addEventListener("message", handleMessage);
    ws.addEventListener("error", handleError);
    ws.addEventListener("close", handleClose);

    return () => {
      ws.removeEventListener("open", handleOpen);
      ws.removeEventListener("message", handleMessage);
      ws.removeEventListener("error", handleError);
      ws.removeEventListener("close", handleClose);
      ws.close();
      wsRef.current = null;
    };
  }, [localId]);

  const sendText = useCallback((text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ text }));
  }, []);

  const stop = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "stop" }));
  }, []);

  return {
    blocks: accState.blocks,
    status: deriveStatus(connectionState, accState.runStatus),
    connectionState,
    interactionState: accState.interactionState,
    resultSummary: accState.resultSummary,
    errorMessage: accState.errorMessage,
    harnessSessionId: accState.harnessSessionId,
    sendText,
    stop,
  };
}

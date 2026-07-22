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

/**
 * Transport-level WebSocket lifecycle — distinct from `status` below, which
 * is the session-run status. `"reconnecting"` (mt#3038) is a DISTINCT state
 * from `"connecting"`: the initial connect attempt is `"connecting"`; a
 * retry after a transient close (an actuator-swap redial signal, or a
 * never-opened channel being retried a bounded number of times) is
 * `"reconnecting"` — so the UI can tell "first contact" from "recovering
 * from an interruption" apart.
 */
export type DrivenSessionConnectionState =
  | "connecting"
  | "reconnecting"
  | "open"
  | "closed"
  | "error";

/**
 * Unified session status (mt#2751 success criterion 4, extended by mt#3038
 * R1 delta #9's four-state model): "connecting / live / reconnecting /
 * exited (with result summary) / crashed / unrecoverable". Derived from BOTH
 * the WS transport state and the accumulator's session-lifecycle
 * `runStatus` — a channel that never opens (auth failure, unknown session
 * id) surfaces as `"crashed"` with a readable `errorMessage` (after the
 * bounded retry budget below is exhausted) rather than hanging on
 * `"connecting"` forever; `"unrecoverable"` overrides everything else once
 * the daemon reports it (R1 delta #2 — never resumable, read-only history).
 */
export type DrivenSessionStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "exited"
  | "crashed"
  | "unrecoverable";

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

/**
 * The actuator-swap reconnect-signal close code (mt#3038 R1 delta #3 —
 * ../driven-session-ws.ts's `wireDrivenSessionSocket` `onSwap` handler closes
 * with this exact code/reason). The 4000-4999 range is reserved for
 * application-defined codes per RFC 6455 §7.4.2.
 */
const ACTUATOR_SWAP_RECONNECT_CLOSE_CODE = 4001;

/** Bounded retry budget for a channel that never opened at all (auth
 * failure, unknown id, or the daemon racing a resume-lock 503 — see
 * ../driven-session-ws.ts's `resolveDrivenSessionForUpgrade`). A swap-signal
 * close (4001) is NOT subject to this budget — see `scheduleReconnect`. */
const MAX_NEVER_LIVE_RECONNECT_ATTEMPTS = 5;
const NEVER_LIVE_RECONNECT_BASE_DELAY_MS = 500;
const ACTUATOR_SWAP_RECONNECT_DELAY_MS = 300;

function deriveStatus(
  connectionState: DrivenSessionConnectionState,
  runStatus: DrivenAccumulatorState["runStatus"]
): DrivenSessionStatus {
  // mt#3038 R1 delta #2 — unrecoverable is TERMINAL and overrides everything
  // else once the daemon reports it (a stale "reconnecting" transport state
  // from a still-in-flight retry must never mask it).
  if (runStatus === "unrecoverable") return "unrecoverable";
  if (runStatus === "exited") return "exited";
  if (runStatus === "crashed") return "crashed";
  if (connectionState === "reconnecting") return "reconnecting";
  if (connectionState === "connecting") return "connecting";
  // Channel closed/errored before the session ever reported running, AND the
  // bounded retry budget above is exhausted — a genuine channel-auth failure
  // or unknown-session-id case (mt#2751 success criterion 4: "a channel auth
  // failure or unknown session renders a readable error").
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
  // mt#3038 R1 delta #9 — reconnect protocol state, entirely new (this hook
  // previously had none: any closed/error transport mapped straight to
  // "crashed"). `everLiveRef` distinguishes "never connected at all" (bound
  // retries, then give up) from "was live, actuator swapped mid-session"
  // (always redial, uncounted). `wsGeneration` is a pure re-render trigger —
  // bumping it re-runs the connect effect, which is how a scheduled retry
  // actually opens a NEW WebSocket.
  const everLiveRef = useRef(false);
  const neverLiveAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLocalIdRef = useRef<string | null | undefined>(undefined);
  const [wsGeneration, setWsGeneration] = useState(0);

  useEffect(() => {
    if (!localId) {
      setConnectionState("closed");
      setAccState(createInitialDrivenAccumulatorState());
      return;
    }

    const isNewLocalId = lastLocalIdRef.current !== localId;
    lastLocalIdRef.current = localId;
    if (isNewLocalId) {
      // A genuinely different session id — reset ALL reconnect bookkeeping
      // and the accumulated conversation state (matches the pre-mt#3038
      // "switching localId resets accumulated state" behavior exactly).
      everLiveRef.current = false;
      neverLiveAttemptsRef.current = 0;
      setAccState(createInitialDrivenAccumulatorState());
      setConnectionState("connecting");
    } else {
      // Same localId, wsGeneration bumped — this IS a reconnect attempt.
      // Accumulated blocks/history are preserved deliberately (the whole
      // point of resuming is continuity, not a blank slate).
      setConnectionState("reconnecting");
    }

    let cancelled = false;
    const ws = new WebSocket(buildDrivenSessionWsUrl(localId));
    wsRef.current = ws;

    const scheduleReconnect = (delayMs: number) => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        if (!cancelled) setWsGeneration((g) => g + 1);
      }, delayMs);
    };

    const handleOpen = () => {
      neverLiveAttemptsRef.current = 0;
      setConnectionState("open");
    };
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
      everLiveRef.current = true;
      setAccState((prev) => foldDrivenSessionEvent(prev, payload as Record<string, unknown>));
    };
    const handleError = () => setConnectionState("error");
    const handleClose = (ev: CloseEvent) => {
      if (cancelled) return;
      wsRef.current = null;

      if (ev.code === ACTUATOR_SWAP_RECONNECT_CLOSE_CODE) {
        // The actuator was swapped out from under this socket (R1 delta #3)
        // — the SAME localId now has a NEW live record on the daemon side.
        // Always redial immediately; this is a designed signal, not a
        // failure, so it is uncounted against the never-live retry budget.
        neverLiveAttemptsRef.current = 0;
        setConnectionState("reconnecting");
        scheduleReconnect(ACTUATOR_SWAP_RECONNECT_DELAY_MS);
        return;
      }

      if (
        !everLiveRef.current &&
        neverLiveAttemptsRef.current < MAX_NEVER_LIVE_RECONNECT_ATTEMPTS
      ) {
        // Never received a single frame yet — could be a transient
        // cross-process resume-lock race (503, R1 delta #1) or the
        // reconciliation read still in flight at daemon boot. Retry with a
        // linear backoff before surfacing a genuine failure.
        neverLiveAttemptsRef.current += 1;
        setConnectionState("reconnecting");
        scheduleReconnect(NEVER_LIVE_RECONNECT_BASE_DELAY_MS * neverLiveAttemptsRef.current);
        return;
      }

      setConnectionState("closed");
    };

    ws.addEventListener("open", handleOpen);
    ws.addEventListener("message", handleMessage);
    ws.addEventListener("error", handleError);
    ws.addEventListener("close", handleClose);

    return () => {
      cancelled = true;
      ws.removeEventListener("open", handleOpen);
      ws.removeEventListener("message", handleMessage);
      ws.removeEventListener("error", handleError);
      ws.removeEventListener("close", handleClose);
      ws.close();
      wsRef.current = null;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [localId, wsGeneration]);

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

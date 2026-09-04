/**
 * DrivenSessionPage — `/driven/:id`, the driven-session view (mt#2751, Rung 2B).
 *
 * Hosts the three pieces success criterion 5 asks for — ConversationView +
 * composer + status — all wired off a SINGLE `useDrivenSession(id)` call, so
 * the composer/status siblings and the thread render share exactly one
 * WebSocket connection (see `../hooks/useDrivenSession.ts`'s docblock for why
 * ConversationView does NOT own this connection itself for the driven case).
 *
 * Launch entry points and task binding (starting a NEW driven session from
 * the cockpit, wiring this route into nav/command-palette) are mt#2751's
 * sibling Rung 2C — out of scope here. This route is reachable by URL (and,
 * later, a `minsky://` deeplink) once a session id exists.
 *
 * @see mt#2751 — this page
 * @see mt#2750 — the daemon-side host + WS channel this drives
 * @see ../hooks/useDrivenSession.ts — the single WS connection this page owns
 * @see ../widgets/ConversationView.tsx — the `drivenSessionId`/`drivenBlocks` variant
 */
import { useEffect, useRef } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { ConversationView } from "../widgets/ConversationView";
import { useDrivenSession } from "../hooks/useDrivenSession";
import { DrivenSessionStatusBar } from "../components/DrivenSessionStatusBar";
import { DrivenSessionComposer } from "../components/DrivenSessionComposer";
import { ErrorState } from "../components/ErrorState";

export function DrivenSessionPage() {
  const { id } = useParams<{ id: string }>();
  // ?compose= carries the command the launch action primed (mt#2986's plan
  // button). It is SENT, not seeded (mt#3375): the operator already chose the
  // action by clicking "Plan in session", so a second click to confirm adds a
  // step and no information.
  const [searchParams] = useSearchParams();
  const composePrefill = searchParams.get("compose") ?? undefined;
  // Hooks must run unconditionally — the hook itself no-ops on a falsy id.
  const driven = useDrivenSession(id);

  // Exactly once per mount. `sendText` buffers until the channel opens, so
  // this does not need to wait for a connection — which is the whole reason
  // the old seed-only behavior existed (the navigate fires before the child's
  // first frame, and the pre-mt#3375 send would have been dropped).
  const autoSentRef = useRef(false);
  const { sendText } = driven;
  useEffect(() => {
    if (autoSentRef.current || !id || !composePrefill) return;
    autoSentRef.current = true;
    sendText(composePrefill);
  }, [id, composePrefill, sendText]);

  if (!id) {
    return (
      <div className="p-4 text-sm text-muted-foreground">No driven session id in the URL.</div>
    );
  }

  // Show the generic connection-failure ErrorState ONLY when the channel
  // genuinely gave up — the bounded reconnect budget in useDrivenSession.ts
  // (mt#3038) is exhausted with the session never having reported ANY frame
  // (no `init` event, so no `harnessSessionId`: auth failure / unknown
  // session / a resume that never succeeded). While a reconnect is in
  // flight (`status === "reconnecting"` — a session driver-swap redial, or a
  // still-retrying never-opened channel) this deliberately does NOT show the
  // ErrorState; that IS the mt#3038 fix for the originating "Could not
  // connect... may not exist" crash on every daemon restart. A session that
  // DID start and then crashed mid-stream keeps its transcript-so-far
  // visible with a `Crashed` status bar — hiding it behind the ErrorState
  // would violate mt#2751's acceptance test ("the view surfaces the exit
  // rather than freezing"). (mt#2751 R2)
  const channelFailed = driven.status === "crashed" && !driven.harnessSessionId;

  return (
    // `h-full` + `min-h-0` are what make the thread box below an actual
    // scrollport (mt#3737). Without a bounded height here the column is sized by
    // its content, `flex-1` on the thread resolves to that content height, and
    // the box never overflows — so the shell's <main> scrolled instead and took
    // the composer and status bar off the top with the transcript. `min-h-0`
    // is the mt#3335 trap in its second location: a column-flex child's
    // automatic minimum size is its content, so without it the thread refuses to
    // shrink and hands the overflow back up the tree.
    <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Drive view</h1>
        <span className="font-mono text-xs text-muted-foreground" title={id}>
          {id}
        </span>
      </div>

      <DrivenSessionStatusBar
        status={driven.status}
        resultSummary={driven.resultSummary}
        errorMessage={driven.errorMessage}
      />

      {channelFailed ? (
        <ErrorState message="Could not connect to the driven session channel. It may not exist, or the connection was refused." />
      ) : (
        // `min-h-0`, not `min-h-[50vh]`: a minimum taller than the space the
        // column can give it would push the box past the viewport and hand the
        // overflow back to <main>, which is the bug. The floor served a
        // content-sized page that no longer exists.
        <div
          // Named so the mt#3737 geometry script can identify the scrollport
          // structurally instead of by its `overflow-y-auto` class, which would
          // silently become ambiguous the moment this page grows a second
          // scroll container.
          data-testid="driven-thread-scrollport"
          className="min-h-0 flex-1 overflow-y-auto rounded border border-border bg-card p-3"
        >
          <ConversationView
            drivenSessionId={id}
            drivenBlocks={driven.blocks}
            harnessKind={driven.harnessKind}
            authMode={driven.authMode}
          />
        </div>
      )}

      <DrivenSessionComposer
        interactionState={driven.interactionState}
        onSend={driven.sendText}
        onStop={driven.stop}
      />
    </div>
  );
}

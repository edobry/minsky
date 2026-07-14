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
import { useParams } from "react-router-dom";
import { ConversationView } from "../widgets/ConversationView";
import { useDrivenSession } from "../hooks/useDrivenSession";
import { DrivenSessionStatusBar } from "../components/DrivenSessionStatusBar";
import { DrivenSessionComposer } from "../components/DrivenSessionComposer";
import { ErrorState } from "../components/ErrorState";

export function DrivenSessionPage() {
  const { id } = useParams<{ id: string }>();
  // Hooks must run unconditionally — the hook itself no-ops on a falsy id.
  const driven = useDrivenSession(id);

  if (!id) {
    return <div className="p-4 text-sm text-muted-foreground">No driven session id in the URL.</div>;
  }

  // Show the generic connection-failure ErrorState ONLY when the channel never
  // opened — a connection-level error, or a socket that closed before the
  // session ever started (no `init` event, so no `harnessSessionId`: auth
  // failure / unknown session). A session that DID start and then crashed
  // mid-stream keeps its transcript-so-far visible with a `Crashed` status bar
  // — hiding it behind the ErrorState would violate mt#2751's acceptance test
  // ("the view surfaces the exit rather than freezing"). (mt#2751 R2)
  const channelFailed =
    driven.connectionState === "error" ||
    (driven.connectionState === "closed" && !driven.harnessSessionId);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Driven session</h1>
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
        <div className="min-h-[50vh] flex-1 overflow-y-auto rounded border border-border bg-card p-3">
          <ConversationView drivenSessionId={id} drivenBlocks={driven.blocks} />
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

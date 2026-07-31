/**
 * AgentDrivenPeek (mt#2912) — the fleet-table row peek for a driven session:
 * the session's last message/prompt context plus a minimal composer, wired
 * through the EXISTING per-session driven WebSocket channel
 * (`useDrivenSession`, mt#2750/2751). No new transport.
 *
 * Deferred slice of mt#2884 (recorded there as plan decision 4, amended at
 * PR #2029 R1): "row expansion shows ... a link plus the driven composer
 * ONLY if `useDrivenSession` embeds without new plumbing." This component IS
 * that embed — it calls `useDrivenSession` exactly once and drills the
 * result to its two children (`DrivenSessionStatusBar` /
 * `DrivenSessionComposer`), mirroring `DrivenSessionPage.tsx`'s "one hook
 * call, siblings consume via props" pattern. Because /agents (where this
 * peek lives) and /driven/:id (`DrivenSessionPage`) are mutually exclusive
 * react-router routes (see `App.tsx`'s `<Routes>`), at most ONE of the two
 * consumers is ever mounted at a time in a given browser tab — so within
 * this SPA there is never more than one concurrent WebSocket connection open
 * for a given driven-session id. This is the "single-connection contract"
 * the mt#2912 spec asks this component to preserve; see
 * `AgentDrivenPeek.test.tsx` for the connection-count assertion this claim
 * rests on.
 *
 * @see mt#2912 — this component
 * @see ../hooks/useDrivenSession.ts — the single-connection WS hook
 * @see ../pages/DrivenSessionPage.tsx — the full-page sibling this mirrors
 * @see ../components/DrivenSessionComposer.tsx — reused composer
 * @see ../components/DrivenSessionStatusBar.tsx — reused status bar
 * @see ../lib/driven-peek-preview.ts — last-message text extraction
 */
import { useDrivenSession } from "../hooks/useDrivenSession";
import { DrivenSessionStatusBar } from "../components/DrivenSessionStatusBar";
import { DrivenSessionComposer } from "../components/DrivenSessionComposer";
import { lastMessagePreview } from "../lib/driven-peek-preview";

export interface AgentDrivenPeekProps {
  /** The driven session's local id — addresses `/driven/:id` and the WS channel. */
  sessionId: string;
}

export function AgentDrivenPeek({ sessionId }: AgentDrivenPeekProps) {
  const driven = useDrivenSession(sessionId);
  const preview = lastMessagePreview(driven.blocks);
  // `lastMessagePreview` returns null for two different situations (see its
  // docblock) — distinguish them here so the empty state stays honest rather
  // than claiming "no messages" when the session has actually said
  // something we just can't render as a text preview (e.g. a bare
  // tool-result block).
  const emptyStateText =
    driven.blocks.length === 0 ? "No messages yet." : "No preview available for the latest message.";

  return (
    <div className="flex flex-col gap-2 py-2 pl-8 pr-2 border-b border-border/60 last:border-0">
      <DrivenSessionStatusBar
        status={driven.status}
        resultSummary={driven.resultSummary}
        errorMessage={driven.errorMessage}
        className="text-xs"
      />
      {preview ? (
        <p className="text-xs text-muted-foreground line-clamp-3 whitespace-pre-wrap">
          {preview}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground italic">{emptyStateText}</p>
      )}
      <DrivenSessionComposer
        interactionState={driven.interactionState}
        onSend={driven.sendText}
        onStop={driven.stop}
      />
    </div>
  );
}

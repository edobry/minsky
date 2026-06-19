/**
 * SessionPage — `/session/:id`, the session entity tab's content (mt#2398).
 *
 * Sessions become first-class navigable entities: this route makes a session
 * URL-addressable (deep-linkable, palette-jumpable, openable as a tab). The
 * body is mt#2374's layout-agnostic ConversationView (readable chat-thread
 * render of the session transcript), re-homed from its explicitly-interim
 * `/conversation` verification host — which this page retires.
 *
 * Richer session detail (commits, modified files, PR state, log tail) is
 * mt#1919's scope and will compose into this page as additional sections/tabs
 * when it lands; this page deliberately ships the conversation body only.
 */
import { useParams } from "react-router-dom";
import { ConversationView } from "../widgets/ConversationView";
import type { ConversationId } from "@minsky/domain/ids";

export function SessionPage() {
  const { id } = useParams<{ id: string }>();

  if (!id) {
    return <div className="p-4 text-sm text-muted-foreground">No session id in the URL.</div>;
  }

  // Mint at the URL boundary: /session/:id carries a harness agentSessionId (ConversationId).
  const conversationId = id as ConversationId;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">Session</h1>
        <span className="font-mono text-xs text-muted-foreground" title={id}>
          {id}
        </span>
      </div>
      <ConversationView sessionId={conversationId} />
    </div>
  );
}
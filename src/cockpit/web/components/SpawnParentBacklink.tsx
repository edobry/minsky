/**
 * "Spawned by" ascent link for a conversation that IS a subagent spawn (mt#3692).
 *
 * Extracted from `../widgets/ConversationView.tsx` rather than defined inline,
 * following the mt#3262 precedent that moved the per-element renderers out of
 * that file: it had grown past the 1500-line hard limit.
 */
import { Link } from "react-router-dom";
import type { SessionContextSnapshot } from "@minsky/domain/context/types";

/**
 * The inverse of the spawn badge on the parent's Agent call: that one descends,
 * this one ascends. A reader who descended gets back without the browser's back
 * button, and one who arrived directly can still see they are inside a
 * delegation rather than at a root.
 *
 * Renders NOTHING when there is no spawn ancestry. A conversation with no parent
 * is the common case, and an empty "not spawned by anything" placeholder would
 * be noise on every root conversation.
 */
export function SpawnParentBacklink({
  parent,
}: {
  parent: SessionContextSnapshot["spawnParent"];
}) {
  if (!parent) return null;

  return (
    <div
      data-testid="spawn-parent-backlink"
      className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
    >
      <span aria-hidden>↑</span>
      <span>Spawned by</span>
      <Link
        to={`/conversation/${parent.agentSessionId}`}
        title={`Open the conversation that dispatched this one (${parent.agentSessionId})`}
        className="rounded font-medium text-violet-300 underline decoration-violet-300/40 underline-offset-2 transition-colors hover:text-violet-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {parent.agentKind ? `${parent.agentKind} dispatch` : "parent conversation"}
      </Link>
    </div>
  );
}

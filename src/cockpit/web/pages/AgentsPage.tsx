/**
 * AgentsPage — full-page route for the Agents widget (/agents).
 *
 * Gives the Agents widget the full content-area width so operator can see
 * more sessions at once without the card-grid column constraint.
 *
 * The Agents widget is self-fetching (TanStack Query), so this page is
 * thin — layout, the widget, and an untasked-conversation launch affordance
 * (mt#2752 SC3: daemon repo cwd, no task binding — startable from the Agents
 * view; task-bound launch lives on the task detail page).
 *
 * The label is the shared `NEW_CONVERSATION_LABEL` (mt#3464), not this page's
 * own wording: the same operation is now reachable from the rail on every
 * route and from ⌘K, and three surfaces naming one operation three ways is
 * how "scratch session" became a term only the implementation understood.
 * This page keeps its own launch button (and its own mutation instance) —
 * it is the driven-session home, and an operator who navigated here to start
 * work should not have to go back to the chrome to do it.
 */
import { Play } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Agents } from "../widgets/Agents";
import { useStartDrivenSession } from "../hooks/useStartDrivenSession";
import {
  NEW_CONVERSATION_DESCRIPTION,
  NEW_CONVERSATION_LABEL,
} from "../lib/new-conversation";

function NewConversationPageButton() {
  const start = useStartDrivenSession();
  return (
    <div className="flex items-center justify-end gap-2">
      {start.isError && (
        <span className="text-xs text-destructive" role="alert">
          {start.error.message}
        </span>
      )}
      <Button variant="outline" size="sm" asChild className="h-7 px-2.5 text-xs">
        <Link to="/agents/cost">Cost &amp; usage</Link>
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => start.mutate({})}
        disabled={start.isPending}
        className="h-7 px-2.5 text-xs"
        title={NEW_CONVERSATION_DESCRIPTION}
      >
        <Play className="h-3.5 w-3.5 mr-1" />
        {start.isPending ? "Starting…" : NEW_CONVERSATION_LABEL}
      </Button>
    </div>
  );
}

export function AgentsPage() {
  return (
    <div className="p-4 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between gap-4 mb-2">
        <h1 className="text-h1 font-semibold text-foreground">Agents</h1>
        <NewConversationPageButton />
      </div>
      {/* page-body variant (mt#2917 fix, same issue as WorkstreamsPage): this
          route renders its own <h1> above, so the widget must not ALSO
          render a nested Card + CardTitle "Agents" — the default "card"
          variant was doing exactly that. */}
      <Agents variant="page-body" title="Agents" />
    </div>
  );
}
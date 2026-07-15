/**
 * AgentsPage — full-page route for the Agents widget (/agents).
 *
 * Gives the Agents widget the full content-area width so operator can see
 * more sessions at once without the card-grid column constraint.
 *
 * The Agents widget is self-fetching (TanStack Query), so this page is
 * thin — layout, the widget, and the scratch-session launch affordance
 * (mt#2752 SC3: an untasked "scratch" driven session — daemon repo cwd, no
 * task binding — startable from the Agents view; task-bound launch lives on
 * the task detail page).
 */
import { Play } from "lucide-react";
import { Button } from "../components/ui/button";
import { Agents } from "../widgets/Agents";
import { useStartDrivenSession } from "../hooks/useStartDrivenSession";

function StartScratchSessionButton() {
  const start = useStartDrivenSession();
  return (
    <div className="flex items-center justify-end gap-2 mb-2">
      {start.isError && (
        <span className="text-xs text-destructive" role="alert">
          {start.error.message}
        </span>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={() => start.mutate({})}
        disabled={start.isPending}
        className="h-7 px-2.5 text-xs"
        aria-label="Start a scratch driven session (repo directory, no task binding)"
        title="Spawn a driven claude session in the daemon's repo directory, bound to no task"
      >
        <Play className="h-3.5 w-3.5 mr-1" />
        {start.isPending ? "Starting…" : "Start scratch session"}
      </Button>
    </div>
  );
}

export function AgentsPage() {
  return (
    <div className="p-4 max-w-5xl mx-auto w-full">
      <StartScratchSessionButton />
      <Agents />
    </div>
  );
}

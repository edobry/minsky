/**
 * TasksPage — full-page route for the TaskGraph widget (/tasks).
 *
 * The TaskGraph widget uses react-flow which needs a defined height. At full
 * page width we can give it more vertical room (800px) than the card version
 * (600px), making the dependency graph more usable.
 *
 * The widget is prop-driven (receives data from App-level polling).
 */
import type { WidgetData } from "../lib/widget-client";
import { TaskGraph } from "../widgets/TaskGraph";

interface TasksPageProps {
  data: WidgetData | null;
}

export function TasksPage({ data }: TasksPageProps) {
  if (data === null) {
    return (
      <div className="p-4 w-full">
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          Loading task graph…
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 w-full">
      {/* TaskGraph renders its own Card + react-flow canvas with the widget's
          CardTitle "Task Graph" serving as the page header. containerClassName
          overrides the default 600px so the canvas fills the viewport:
          100vh minus app header (h-14 = 3.5rem) + page padding (2rem)
          + card header (3.5rem) + card-content top padding (0.5rem) ≈ 9.5rem. */}
      <TaskGraph data={data} containerClassName="h-[calc(100vh-9.5rem)]" />
    </div>
  );
}

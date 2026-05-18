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
      <div className="flex flex-col gap-4 p-4 w-full">
        <div>
          <h1 className="text-base font-semibold text-foreground">Task Graph</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Dependency graph of all Minsky tasks
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          Loading task graph…
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 w-full">
      <div>
        <h1 className="text-base font-semibold text-foreground">Task Graph</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Dependency graph of all Minsky tasks
        </p>
      </div>
      {/* TaskGraph renders its own Card + react-flow canvas */}
      <TaskGraph data={data} />
    </div>
  );
}

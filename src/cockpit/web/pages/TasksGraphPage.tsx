/**
 * TasksGraphPage — graph view route for /tasks/graph (child of TasksLayout).
 *
 * Wraps the TaskGraph widget at a full-page height.
 * Data comes from TasksLayout via React Router outlet context.
 */
import { useOutletContext } from "react-router-dom";
import type { WidgetData } from "../lib/widget-client";
import { TaskGraph } from "../widgets/TaskGraph";

interface TasksOutletContext {
  taskGraphData: WidgetData | null;
}

export function TasksGraphPage() {
  const { taskGraphData } = useOutletContext<TasksOutletContext>();

  if (taskGraphData === null) {
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
          + card header (3.5rem) + card-content top padding (0.5rem)
          + tasks layout header (tab bar ~3rem) ≈ 12.5rem. */}
      <TaskGraph data={taskGraphData} containerClassName="h-[calc(100vh-12.5rem)]" />
    </div>
  );
}

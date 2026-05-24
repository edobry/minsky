/**
 * TasksListPage — list view route for /tasks (index child of TasksLayout).
 *
 * Thin wrapper: receives taskGraphData from TasksLayout via the outlet
 * context (React Router's useOutletContext) and passes it to TasksList.
 */
import { useOutletContext } from "react-router-dom";
import type { WidgetData } from "../lib/widget-client";
import { TasksList } from "../widgets/TasksList";

interface TasksOutletContext {
  taskGraphData: WidgetData | null;
}

export function TasksListPage() {
  const { taskGraphData } = useOutletContext<TasksOutletContext>();

  return (
    <div className="p-4 w-full">
      <TasksList data={taskGraphData} />
    </div>
  );
}

/**
 * TasksListPage — list view route for /tasks (index child of TasksLayout).
 *
 * Uses the self-fetching TaskList widget (TanStack Query) from mt#2078.
 * The TasksLayout parent provides the tab switcher; this page just renders
 * the widget content.
 */
import { TaskList } from "../widgets/TaskList";

export function TasksListPage() {
  return (
    <div className="p-4 w-full">
      <TaskList />
    </div>
  );
}

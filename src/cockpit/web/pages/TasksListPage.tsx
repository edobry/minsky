/**
 * TasksListPage — full-page route for the flat task list (/tasks/list).
 *
 * The TaskList widget is self-fetching (TanStack Query), so this page is
 * thin — just layout wrapper + the widget.
 */
import { TaskList } from "../widgets/TaskList";

export function TasksListPage() {
  return (
    <div className="p-4 max-w-5xl mx-auto w-full">
      <TaskList />
    </div>
  );
}

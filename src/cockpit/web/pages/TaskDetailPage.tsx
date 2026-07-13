/**
 * TaskDetailPage — detail view route for /tasks/:id (mt#1918).
 *
 * Extracts the task ID from the URL param, decodes it, and renders the
 * self-fetching TaskDetail widget. A breadcrumb back to the list and a
 * title are shown above the widget card.
 *
 * Route registration: child of TasksLayout, matched BEFORE /tasks/graph
 * because React Router v7 always tests literal segments ("graph") before
 * parameterised ones (":id") regardless of registration order, so there
 * is no conflict.
 */
import { useParams } from "react-router-dom";
import { Link } from "react-router-dom";
import { TaskDetail } from "../widgets/TaskDetail";

export function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();

  // id from useParams is already URL-decoded by React Router
  const taskId = id ?? "";

  return (
    <div className="p-4 w-full max-w-4xl">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-xs text-muted-foreground mb-3" aria-label="Breadcrumb">
        <Link
          to="/tasks"
          className="hover:text-foreground transition-colors"
        >
          Tasks
        </Link>
        <span aria-hidden="true">/</span>
        <span className="font-mono text-foreground">{taskId}</span>
      </nav>

      {taskId ? (
        <TaskDetail taskId={taskId} />
      ) : (
        <p className="text-sm text-muted-foreground">No task ID in URL.</p>
      )}
    </div>
  );
}

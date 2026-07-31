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
import { CopyId } from "../components/CopyId";
import { EntityThreadPanel } from "../widgets/EntityThreadPanel";

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
        <CopyId type="task" id={taskId} />
      </nav>

      {taskId ? (
        <>
          <TaskDetail taskId={taskId} />
          {/* mt#3366 — the discussion thread, same component as the ask route.
              No `proposalSlot` is supplied: a resolve proposal is ask-specific,
              and the seed prompt correspondingly does not teach the marker for
              a task, so there is nothing to render here.

              Gated on `taskId` rather than on a loaded task because TaskDetail
              is self-fetching and does not surface its result to this page. For
              a nonexistent id the thread endpoint 404s and the panel says so —
              honest, if alongside TaskDetail's own not-found. */}
          <EntityThreadPanel entityType="task" entityId={taskId} className="mt-6" />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No task ID in URL.</p>
      )}
    </div>
  );
}

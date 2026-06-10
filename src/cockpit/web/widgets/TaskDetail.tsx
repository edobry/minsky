/**
 * TaskDetail widget frontend (mt#1918)
 *
 * Self-fetching via TanStack Query. Renders a single task's full detail view:
 * header (ID + title + status + kind), spec content, parent, children, and
 * deps (incoming + outgoing). Read-only; editing is deferred to v0.2.
 *
 * Takes the task ID from a URL param passed by the parent page component.
 */
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { WidgetShell, type WidgetVariant } from "../components/WidgetShell";

// ---------------------------------------------------------------------------
// Types — mirrors the /api/tasks/:id response shape
// ---------------------------------------------------------------------------

export interface TaskRef {
  id: string;
  title: string;
  status: string;
}

export interface TaskDetailPayload {
  task: {
    id: string;
    title: string;
    status: string;
    kind: string;
    tags: string[];
  };
  spec: string | null;
  parent: TaskRef | null;
  children: TaskRef[];
  deps: {
    outgoing: TaskRef[];
    incoming: TaskRef[];
  };
}

function isTaskDetailPayload(v: unknown): v is TaskDetailPayload {
  return (
    typeof v === "object" &&
    v !== null &&
    "task" in v &&
    typeof (v as { task: unknown }).task === "object"
  );
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchTaskDetail(taskId: string): Promise<TaskDetailPayload> {
  const encoded = encodeURIComponent(taskId);
  const res = await fetch(`/api/tasks/${encoded}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<TaskDetailPayload>;
}

// ---------------------------------------------------------------------------
// Status badge — same palette as TaskList / Workstreams / TaskGraph
// ---------------------------------------------------------------------------

interface StatusStyle {
  background: string;
  border: string;
  color: string;
}

function statusStyle(status: string): StatusStyle {
  switch (status.toUpperCase()) {
    case "DONE":
    case "COMPLETED":
      return { background: "#34d399", border: "#059669", color: "#064e3b" };
    case "IN-PROGRESS":
      return { background: "#fbbf24", border: "#d97706", color: "#78350f" };
    case "IN-REVIEW":
      return { background: "#a78bfa", border: "#7c3aed", color: "#2e1065" };
    case "READY":
      return { background: "#60a5fa", border: "#2563eb", color: "#1e3a8a" };
    case "BLOCKED":
      return { background: "#f87171", border: "#dc2626", color: "#7f1d1d" };
    case "PLANNING":
      return { background: "#67e8f9", border: "#0891b2", color: "#164e63" };
    case "CLOSED":
      return { background: "#d1d5db", border: "#6b7280", color: "#374151" };
    case "TODO":
    default:
      return { background: "#e2e8f0", border: "#64748b", color: "#1e293b" };
  }
}

function StatusBadge({ status }: { status: string }) {
  const s = statusStyle(status);
  return (
    <span
      className="text-xs px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap"
      style={{ background: s.background, color: s.color, border: `1px solid ${s.border}` }}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Task ID chip — monospace, links to detail page
// ---------------------------------------------------------------------------

function TaskIdChip({ id }: { id: string }) {
  return (
    <Link
      to={`/tasks/${encodeURIComponent(id)}`}
      className="font-mono text-xs px-1.5 py-0.5 rounded bg-muted text-foreground hover:bg-muted/70 transition-colors"
    >
      {id}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Task reference row — ID chip + title + status badge
// ---------------------------------------------------------------------------

function TaskRefRow({ task }: { task: TaskRef }) {
  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-border last:border-0">
      <StatusBadge status={task.status} />
      <TaskIdChip id={task.id} />
      <span className="text-sm truncate flex-1">{task.title}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spec content — rendered as preformatted text (no new markdown dep)
// ---------------------------------------------------------------------------

function SpecContent({ content }: { content: string | null }) {
  if (!content) {
    return (
      <p className="text-sm text-muted-foreground italic">No spec content</p>
    );
  }
  return (
    <pre className="text-xs font-mono text-foreground whitespace-pre-wrap break-words leading-relaxed bg-muted/20 rounded p-3 overflow-auto max-h-[60vh]">
      {content}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// Section wrapper — consistent heading + content layout
// ---------------------------------------------------------------------------

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-4 first:mt-0">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
        {title}
      </h3>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inner — rendered after data is confirmed
// ---------------------------------------------------------------------------

function TaskDetailInner({ data }: { data: TaskDetailPayload }) {
  const { task, spec, parent, children, deps } = data;

  return (
    <div className="flex flex-col gap-0">
      {/* Header */}
      <div className="flex items-start gap-3 flex-wrap pb-4 border-b border-border">
        <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-muted text-foreground">
          {task.id}
        </span>
        <StatusBadge status={task.status} />
        <span className="text-xs px-1.5 py-0.5 rounded border border-border text-muted-foreground">
          {task.kind}
        </span>
        {task.tags.map((tag) => (
          <span
            key={tag}
            className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
          >
            {tag}
          </span>
        ))}
      </div>

      {/* Parent */}
      {parent && (
        <Section title="Parent">
          <div className="flex items-center gap-2">
            <StatusBadge status={parent.status} />
            <TaskIdChip id={parent.id} />
            <span className="text-sm text-muted-foreground truncate">{parent.title}</span>
          </div>
        </Section>
      )}

      {/* Spec */}
      <Section title="Spec">
        <SpecContent content={spec} />
      </Section>

      {/* Children */}
      <Section title={`Children (${children.length})`}>
        {children.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No children</p>
        ) : (
          <div>
            {children.map((c) => (
              <TaskRefRow key={c.id} task={c} />
            ))}
          </div>
        )}
      </Section>

      {/* Dependencies */}
      {(deps.outgoing.length > 0 || deps.incoming.length > 0) && (
        <Section title="Dependencies">
          {deps.outgoing.length > 0 && (
            <div className="mb-3">
              <p className="text-xs text-muted-foreground mb-1">
                Depends on ({deps.outgoing.length}):
              </p>
              {deps.outgoing.map((d) => (
                <TaskRefRow key={d.id} task={d} />
              ))}
            </div>
          )}
          {deps.incoming.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                Required by ({deps.incoming.length}):
              </p>
              {deps.incoming.map((d) => (
                <TaskRefRow key={d.id} task={d} />
              ))}
            </div>
          )}
        </Section>
      )}

      {deps.outgoing.length === 0 && deps.incoming.length === 0 && (
        <Section title="Dependencies">
          <p className="text-sm text-muted-foreground italic">No dependencies</p>
        </Section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chrome-agnostic body — no Card/CardHeader/CardTitle in any branch
// ---------------------------------------------------------------------------

interface TaskDetailBodyProps {
  taskId: string;
  query: ReturnType<typeof useQuery<TaskDetailPayload, Error>>;
}

function TaskDetailBody({ taskId, query }: TaskDetailBodyProps) {
  if (query.isLoading) {
    return (
      <p className="text-muted-foreground text-sm font-mono">Loading {taskId}…</p>
    );
  }

  if (query.isError) {
    const msg = query.error.message;
    const isNotFound = msg.includes("not found") || msg.includes("404");
    return (
      <p className="text-muted-foreground text-sm font-mono">
        {isNotFound ? `Task ${taskId} not found.` : `Error: ${msg}`}
      </p>
    );
  }

  const data = query.data;
  if (!data || !isTaskDetailPayload(data)) {
    return <p className="text-muted-foreground text-sm font-mono">Unexpected response shape.</p>;
  }

  return <TaskDetailInner data={data} />;
}

// ---------------------------------------------------------------------------
// Main widget export — self-fetching via TanStack Query (mt#2373)
//
// Title is dynamic: taskId (font-mono) while loading/error, data.task.title
// (leading-snug) on success. WidgetShell title is registry-driven; the
// font-mono/leading-snug styling difference is preserved by rendering the
// title text inline via a `title` prop that switches on query state.
// ---------------------------------------------------------------------------

interface TaskDetailProps {
  taskId: string;
  /** Render-context variant; defaults to the full-page card frame. */
  variant?: WidgetVariant;
}

export function TaskDetail({ taskId, variant = "card" }: TaskDetailProps) {
  const query = useQuery<TaskDetailPayload, Error>({
    queryKey: ["task-detail", taskId],
    queryFn: () => fetchTaskDetail(taskId),
    staleTime: 30_000,
    retry: 1,
  });

  // Dynamic title: task.title on success, taskId while loading/error
  const title =
    query.data && isTaskDetailPayload(query.data) ? query.data.task.title : taskId;

  return (
    <WidgetShell variant={variant} title={title}>
      <TaskDetailBody taskId={taskId} query={query} />
    </WidgetShell>
  );
}

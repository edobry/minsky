/**
 * TasksList widget (mt#1923)
 *
 * Flat sortable/filterable table of all tasks.
 * Data comes from the same task-graph payload used by TaskGraph.tsx —
 * graph nodes carry id, label (formatted as "mt#X: title"), and status.
 * Additional fields (kind, parent, age) are not present in the graph
 * payload; they display as "—" until a richer endpoint ships.
 *
 * Sort keys: id, title, status
 * Filters: status, kind (always "all" since kind is not in payload)
 * Pagination: 25/50/100 per page, via useListControls prefix "tk"
 */
import { useCallback, useMemo } from "react";
import { useListControls, type SortDir } from "../lib/useListControls";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// Types — inline mirror of the server GraphNode shape.
// Keep in sync with src/cockpit/widgets/task-graph.ts.
// ---------------------------------------------------------------------------

type TaskStatus =
  | "TODO"
  | "READY"
  | "IN-PROGRESS"
  | "IN-REVIEW"
  | "DONE"
  | "BLOCKED"
  | "CLOSED"
  | "PLANNING"
  | "COMPLETED";

interface GraphNode {
  id: string;
  label: string;
  status: TaskStatus;
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

interface TaskGraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

type WidgetData = { state: "ok"; payload: unknown } | { state: "degraded"; reason: string };

interface TaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  /** Not available in graph payload — derived from parent edge if present */
  parentId: string | null;
}

// ---------------------------------------------------------------------------
// Extract flat task list from graph payload
// ---------------------------------------------------------------------------

function extractTasks(data: WidgetData): TaskRow[] {
  if (data.state !== "ok") return [];
  const payload = data.payload as TaskGraphPayload;
  const nodes = payload.nodes ?? [];
  const edges = payload.edges ?? [];

  // Build parent map: child → parent (first edge where child = source, parent = target)
  // Edge semantics: source = dependent (has a dep), target = dependency
  // Parent edges are "depends" edges where target is the parent task.
  // Since the graph payload only has "depends" edges, we can't derive parent from it.
  // We leave parentId null for now.
  void edges; // suppressed until parent-edge type ships

  return nodes.map((n) => {
    // Label format from server: "mt#X: title" or just "mt#X" for untitled tasks
    const colonIdx = n.label.indexOf(": ");
    const title = colonIdx >= 0 ? n.label.slice(colonIdx + 2) : "";
    return {
      id: n.id,
      title,
      status: n.status,
      parentId: null,
    };
  });
}

// ---------------------------------------------------------------------------
// Status badge styles (semantic tokens — semantic layer through Tailwind)
// ---------------------------------------------------------------------------

const STATUS_BADGE_CLASSES: Record<TaskStatus, string> = {
  TODO: "bg-muted text-muted-foreground border-border",
  PLANNING: "bg-sky-900/40 text-sky-300 border-sky-700/50",
  READY: "bg-primary/20 text-primary border-primary/40",
  "IN-PROGRESS": "bg-amber-900/40 text-amber-300 border-amber-700/50",
  "IN-REVIEW": "bg-violet-900/40 text-violet-300 border-violet-700/50",
  DONE: "bg-emerald-900/40 text-emerald-300 border-emerald-700/50",
  BLOCKED: "bg-red-900/40 text-red-300 border-red-700/50",
  CLOSED: "opacity-50 bg-muted text-muted-foreground border-border",
  COMPLETED: "bg-emerald-900/20 text-emerald-400 border-emerald-700/30",
};

function StatusBadge({ status }: { status: TaskStatus }) {
  const cls = STATUS_BADGE_CLASSES[status] ?? STATUS_BADGE_CLASSES.TODO;
  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border",
        cls
      )}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sort / filter config
// ---------------------------------------------------------------------------

type TaskSortKey = "id" | "title" | "status";

interface TaskFilters {
  status: string; // "" = all
}

const DEFAULT_FILTERS: TaskFilters = {
  status: "",
};

const ALL_STATUSES: TaskStatus[] = [
  "TODO",
  "PLANNING",
  "READY",
  "IN-PROGRESS",
  "IN-REVIEW",
  "DONE",
  "BLOCKED",
  "CLOSED",
  "COMPLETED",
];

// ---------------------------------------------------------------------------
// Sort column header
// ---------------------------------------------------------------------------

interface SortHeaderProps {
  label: string;
  sortKey: TaskSortKey;
  currentKey: TaskSortKey;
  currentDir: SortDir;
  onSort: (key: TaskSortKey) => void;
  className?: string;
}

function SortHeader({ label, sortKey, currentKey, currentDir, onSort, className }: SortHeaderProps) {
  const isActive = currentKey === sortKey;
  return (
    <button
      onClick={() => onSort(sortKey)}
      className={cn(
        "flex items-center gap-1 text-left text-xs font-medium text-muted-foreground",
        "hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded",
        isActive && "text-foreground",
        className
      )}
      aria-label={`Sort by ${label}`}
    >
      {label}
      <span className="text-xs" aria-hidden>
        {isActive ? (currentDir === "asc" ? "↑" : "↓") : "↕"}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main widget component
// ---------------------------------------------------------------------------

interface TasksListProps {
  data: WidgetData | null;
}

export function TasksList({ data }: TasksListProps) {
  const tasks = useMemo<TaskRow[]>(
    () => (data ? extractTasks(data) : []),
    [data]
  );

  const filterFn = useCallback(
    (item: TaskRow, filters: TaskFilters) => {
      if (filters.status && item.status !== filters.status) return false;
      return true;
    },
    []
  );

  const sortFn = useCallback(
    (a: TaskRow, b: TaskRow, key: TaskSortKey, dir: SortDir): number => {
      const sign = dir === "asc" ? 1 : -1;
      switch (key) {
        case "id":
          // Numeric sort on the task ID number (mt#1923 → 1923)
          return sign * (extractIdNum(a.id) - extractIdNum(b.id));
        case "title":
          return sign * a.title.localeCompare(b.title);
        case "status":
          return sign * a.status.localeCompare(b.status);
        default:
          return 0;
      }
    },
    []
  );

  const controls = useListControls<TaskRow, TaskSortKey, TaskFilters>({
    items: tasks,
    defaultPageSize: 25,
    defaultSortKey: "id",
    defaultSortDir: "desc",
    defaultFilters: DEFAULT_FILTERS,
    filterFn,
    sortFn,
    pageSizeOptions: [25, 50, 100],
    prefix: "tk",
  });

  // Loading state
  if (data === null) {
    return (
      <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
        Loading tasks…
      </div>
    );
  }

  // Degraded state
  if (data.state === "degraded") {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
        Task data unavailable: {data.reason}
      </div>
    );
  }

  const {
    pageItems,
    filteredCount,
    totalCount,
    page,
    pageSize,
    pageCount,
    sortKey,
    sortDir,
    filters,
    pageSizeOptions,
    setPage,
    setPageSize,
    setSort,
    setFilter,
    clearFilters,
    hasActiveFilters,
  } = controls;

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Status filter */}
        <select
          value={filters.status}
          onChange={(e) => setFilter("status", e.target.value)}
          className={cn(
            "h-7 rounded border border-border bg-card px-2 text-xs text-foreground",
            "focus:outline-none focus:ring-2 focus:ring-ring",
            filters.status && "border-primary"
          )}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          {ALL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        {/* Clear filters */}
        {hasActiveFilters && (
          <button
            onClick={clearFilters}
            className="h-7 rounded border border-border bg-card px-2 text-xs text-muted-foreground hover:text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring"
          >
            Clear filters
          </button>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Count */}
        <span className="text-xs text-muted-foreground tabular-nums">
          {hasActiveFilters ? (
            <>{filteredCount} of {totalCount} tasks</>
          ) : (
            <>{totalCount} tasks</>
          )}
        </span>

        {/* Page size */}
        <select
          value={pageSize}
          onChange={(e) => setPageSize(Number(e.target.value))}
          className="h-7 rounded border border-border bg-card px-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          aria-label="Rows per page"
        >
          {pageSizeOptions.map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm" role="grid" aria-label="Tasks">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="px-3 py-2 text-left w-28">
                <SortHeader
                  label="ID"
                  sortKey="id"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={setSort}
                />
              </th>
              <th className="px-3 py-2 text-left">
                <SortHeader
                  label="Title"
                  sortKey="title"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={setSort}
                />
              </th>
              <th className="px-3 py-2 text-left w-32">
                <SortHeader
                  label="Status"
                  sortKey="status"
                  currentKey={sortKey}
                  currentDir={sortDir}
                  onSort={setSort}
                />
              </th>
              <th className="px-3 py-2 text-left w-24 text-xs font-medium text-muted-foreground">
                Parent
              </th>
            </tr>
          </thead>
          <tbody>
            {pageItems.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {hasActiveFilters
                    ? "No tasks match the current filters."
                    : "No tasks found."}
                </td>
              </tr>
            ) : (
              pageItems.map((task, idx) => (
                <TaskListRow key={task.id} task={task} isEven={idx % 2 === 0} />
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pageCount > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground tabular-nums">
            Page {page} of {pageCount}
          </span>
          <div className="flex items-center gap-1">
            <PageButton
              label="← Prev"
              onClick={() => setPage(page - 1)}
              disabled={page <= 1}
            />
            {/* Page number buttons — show up to 5 around current */}
            {buildPageRange(page, pageCount).map((p) =>
              p === null ? (
                <span key={`ellipsis-${Math.random()}`} className="px-1 text-xs text-muted-foreground">…</span>
              ) : (
                <PageButton
                  key={p}
                  label={String(p)}
                  onClick={() => setPage(p)}
                  disabled={p === page}
                  active={p === page}
                />
              )
            )}
            <PageButton
              label="Next →"
              onClick={() => setPage(page + 1)}
              disabled={page >= pageCount}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

function TaskListRow({ task, isEven }: { task: TaskRow; isEven: boolean }) {
  return (
    <tr
      className={cn(
        "border-b border-border/40 last:border-0",
        "hover:bg-muted/30 transition-colors",
        isEven ? "bg-transparent" : "bg-muted/10"
      )}
      role="row"
    >
      {/* Task ID chip */}
      <td className="px-3 py-1.5">
        <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-muted text-foreground">
          {task.id}
        </span>
      </td>
      {/* Title */}
      <td className="px-3 py-1.5">
        <span className="text-sm text-foreground leading-snug">
          {task.title || <span className="text-muted-foreground italic">untitled</span>}
        </span>
      </td>
      {/* Status */}
      <td className="px-3 py-1.5">
        <StatusBadge status={task.status} />
      </td>
      {/* Parent */}
      <td className="px-3 py-1.5">
        {task.parentId ? (
          <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            {task.parentId}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground/40">—</span>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractIdNum(id: string): number {
  const m = id.match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

function buildPageRange(page: number, pageCount: number): (number | null)[] {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const pages: (number | null)[] = [1];
  if (page > 3) pages.push(null);
  for (let p = Math.max(2, page - 1); p <= Math.min(pageCount - 1, page + 1); p++) {
    pages.push(p);
  }
  if (page < pageCount - 2) pages.push(null);
  pages.push(pageCount);
  return pages;
}

function PageButton({
  label,
  onClick,
  disabled,
  active,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "h-6 min-w-[1.5rem] px-1.5 rounded text-xs transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:opacity-40 disabled:cursor-not-allowed",
        active
          ? "bg-primary text-primary-foreground font-medium"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
      )}
    >
      {label}
    </button>
  );
}

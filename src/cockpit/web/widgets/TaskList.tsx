/**
 * TaskList widget frontend (mt#2078)
 *
 * Flat sortable/filterable table of all tasks. Self-fetching via TanStack
 * Query. Complements the TaskGraph DAG view with a scan-friendly list.
 *
 * Uses useListControls with prefix "tl" for URL param persistence.
 */
import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { useListControls, type SortDir } from "../lib/useListControls";

// ---------------------------------------------------------------------------
// Types — mirror of server TaskListItem / TaskListPayload
// ---------------------------------------------------------------------------

interface TaskListItem {
  id: string;
  title: string;
  status: string;
  kind: string;
  tags: string[];
  parentId: string | null;
}

interface TaskListPayload {
  tasks: TaskListItem[];
}

function isTaskListPayload(payload: unknown): payload is TaskListPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as { tasks?: unknown }).tasks)
  );
}

async function fetchTaskList(): Promise<WidgetData> {
  return fetchWidgetData("task-list");
}

// ---------------------------------------------------------------------------
// Sort / filter config
// ---------------------------------------------------------------------------

type TaskSortKey = "id" | "title" | "status" | "kind";

interface TaskFilters {
  status: string;
  search: string;
  kind: string;
}

const DEFAULT_FILTERS: TaskFilters = {
  status: "all",
  search: "",
  kind: "all",
};

// ---------------------------------------------------------------------------
// Status palette — same as Workstreams/TaskGraph
// ---------------------------------------------------------------------------

interface StatusStyle {
  background: string;
  border: string;
  color: string;
}

function statusStyle(status: string): StatusStyle {
  switch (status.toUpperCase()) {
    case "DONE":
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
    case "COMPLETED":
      return { background: "#34d399", border: "#059669", color: "#064e3b" };
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
// Sort direction indicator
// ---------------------------------------------------------------------------

function SortIndicator({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) {
    return <span className="text-muted-foreground opacity-30 ml-0.5">↕</span>;
  }
  return <span className="ml-0.5">{dir === "asc" ? "↑" : "↓"}</span>;
}

// ---------------------------------------------------------------------------
// All known statuses for the filter dropdown
// ---------------------------------------------------------------------------

const ALL_STATUSES = [
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
// Control bar
// ---------------------------------------------------------------------------

interface ControlBarProps {
  sortKey: TaskSortKey;
  sortDir: SortDir;
  filters: TaskFilters;
  pageSize: number;
  pageSizeOptions: number[];
  hasActiveFilters: boolean;
  kinds: string[];
  onSort: (key: TaskSortKey) => void;
  onFilterStatus: (value: string) => void;
  onFilterSearch: (value: string) => void;
  onFilterKind: (value: string) => void;
  onPageSize: (size: number) => void;
  onClearFilters: () => void;
}

function TaskListControlBar({
  sortKey,
  sortDir,
  filters,
  pageSize,
  pageSizeOptions,
  hasActiveFilters,
  kinds,
  onSort,
  onFilterStatus,
  onFilterSearch,
  onFilterKind,
  onPageSize,
  onClearFilters,
}: ControlBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 py-2 mb-2 border-b border-border">
      {/* Sort controls */}
      <span className="text-xs text-muted-foreground uppercase tracking-wide mr-1">Sort:</span>
      {(["id", "title", "status", "kind"] as TaskSortKey[]).map((key) => (
        <button
          key={key}
          onClick={() => onSort(key)}
          className={`text-xs px-2 py-1 rounded border transition-colors ${
            sortKey === key
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground"
          }`}
          aria-pressed={sortKey === key}
        >
          {key === "id" ? "ID" : key.charAt(0).toUpperCase() + key.slice(1)}
          <SortIndicator active={sortKey === key} dir={sortDir} />
        </button>
      ))}

      <span className="text-border mx-1">|</span>

      {/* Status filter */}
      <span className="text-xs text-muted-foreground uppercase tracking-wide mr-1">Status:</span>
      <select
        value={filters.status}
        onChange={(e) => onFilterStatus(e.target.value)}
        className="text-xs bg-background border border-border rounded px-1.5 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        aria-label="Filter by status"
      >
        <option value="all">All</option>
        {ALL_STATUSES.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>

      {/* Kind filter */}
      {kinds.length > 1 && (
        <>
          <span className="text-xs text-muted-foreground ml-1">Kind:</span>
          <select
            value={filters.kind}
            onChange={(e) => onFilterKind(e.target.value)}
            className="text-xs bg-background border border-border rounded px-1.5 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            aria-label="Filter by kind"
          >
            <option value="all">All</option>
            {kinds.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </>
      )}

      {/* Search */}
      <span className="text-xs text-muted-foreground ml-1">Search:</span>
      <input
        type="text"
        value={filters.search}
        onChange={(e) => onFilterSearch(e.target.value)}
        placeholder="title or ID..."
        className="text-xs bg-background border border-border rounded px-1.5 py-1 w-32 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
        aria-label="Search tasks by title or ID"
      />

      <span className="text-border mx-1">|</span>

      {/* Page size */}
      <span className="text-xs text-muted-foreground">Per page:</span>
      <select
        value={pageSize}
        onChange={(e) => onPageSize(Number(e.target.value))}
        className="text-xs bg-background border border-border rounded px-1.5 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        aria-label="Items per page"
      >
        {pageSizeOptions.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>

      {/* Clear filters */}
      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onClearFilters}
          className="text-xs h-6 px-2 ml-auto"
        >
          Clear filters
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pagination bar
// ---------------------------------------------------------------------------

interface PaginationBarProps {
  page: number;
  pageCount: number;
  filteredCount: number;
  totalCount: number;
  onPage: (p: number) => void;
}

function PaginationBar({ page, pageCount, filteredCount, totalCount, onPage }: PaginationBarProps) {
  if (pageCount <= 1 && filteredCount === totalCount) return null;
  return (
    <div className="flex items-center justify-between pt-2 mt-1 border-t border-border">
      <span className="text-xs text-muted-foreground">
        {filteredCount === totalCount
          ? `${totalCount} task${totalCount === 1 ? "" : "s"}`
          : `${filteredCount} of ${totalCount} shown`}
      </span>
      {pageCount > 1 && (
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPage(page - 1)}
            disabled={page <= 1}
            className="h-6 px-2 text-xs"
            aria-label="Previous page"
          >
            ←
          </Button>
          <span className="text-xs text-muted-foreground px-1 tabular-nums">
            {page} / {pageCount}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPage(page + 1)}
            disabled={page >= pageCount}
            className="h-6 px-2 text-xs"
            aria-label="Next page"
          >
            →
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table header
// ---------------------------------------------------------------------------

function TaskTableHeader({
  sortKey,
  sortDir,
  onSort,
}: {
  sortKey: TaskSortKey;
  sortDir: SortDir;
  onSort: (key: TaskSortKey) => void;
}) {
  return (
    <div className="flex items-center gap-3 py-1.5 mb-0.5 border-b border-border">
      <button
        onClick={() => onSort("status")}
        className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex-shrink-0 w-24 text-left hover:text-foreground transition-colors"
      >
        Status
        <SortIndicator active={sortKey === "status"} dir={sortDir} />
      </button>
      <button
        onClick={() => onSort("id")}
        className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex-shrink-0 w-20 text-left hover:text-foreground transition-colors"
      >
        ID
        <SortIndicator active={sortKey === "id"} dir={sortDir} />
      </button>
      <button
        onClick={() => onSort("title")}
        className="flex-1 text-xs font-medium text-muted-foreground uppercase tracking-wide text-left hover:text-foreground transition-colors"
      >
        Title
        <SortIndicator active={sortKey === "title"} dir={sortDir} />
      </button>
      <button
        onClick={() => onSort("kind")}
        className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex-shrink-0 w-28 text-left hover:text-foreground transition-colors"
      >
        Kind
        <SortIndicator active={sortKey === "kind"} dir={sortDir} />
      </button>
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex-shrink-0 w-16 text-left">
        Parent
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task row
// ---------------------------------------------------------------------------

function TaskRowItem({ task }: { task: TaskListItem }) {
  return (
    <div className="flex items-center gap-3 py-1.5 border-b border-border last:border-0">
      <div className="flex-shrink-0 w-24">
        <StatusBadge status={task.status} />
      </div>
      <span className="text-xs font-mono text-muted-foreground flex-shrink-0 w-20">
        {task.id}
      </span>
      <div className="flex-1 min-w-0">
        <span className="text-sm truncate block">{task.title}</span>
        {task.tags.length > 0 && (
          <div className="flex gap-1 mt-0.5">
            {task.tags.map((tag) => (
              <span
                key={tag}
                className="text-[10px] px-1 py-0 rounded bg-muted text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
      <span className="text-xs text-muted-foreground flex-shrink-0 w-28 truncate">
        {task.kind}
      </span>
      <span className="text-xs font-mono text-muted-foreground flex-shrink-0 w-16">
        {task.parentId ?? "—"}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter / sort functions
// ---------------------------------------------------------------------------

function taskFilterFn(task: TaskListItem, filters: TaskFilters): boolean {
  if (filters.status !== "all" && task.status.toUpperCase() !== filters.status.toUpperCase()) {
    return false;
  }
  if (filters.kind !== "all" && task.kind !== filters.kind) {
    return false;
  }
  if (filters.search.trim() !== "") {
    const needle = filters.search.trim().toLowerCase();
    if (
      !task.title.toLowerCase().includes(needle) &&
      !task.id.toLowerCase().includes(needle)
    ) {
      return false;
    }
  }
  return true;
}

function taskSortFn(a: TaskListItem, b: TaskListItem, key: TaskSortKey, dir: SortDir): number {
  let cmp = 0;
  switch (key) {
    case "id": {
      const numA = parseInt(a.id.replace(/\D/g, ""), 10);
      const numB = parseInt(b.id.replace(/\D/g, ""), 10);
      cmp = isNaN(numA) || isNaN(numB) ? a.id.localeCompare(b.id) : numA - numB;
      break;
    }
    case "title":
      cmp = a.title.localeCompare(b.title);
      break;
    case "status":
      cmp = a.status.localeCompare(b.status);
      break;
    case "kind":
      cmp = a.kind.localeCompare(b.kind);
      break;
  }
  if (cmp === 0 && key !== "id") {
    const numA = parseInt(a.id.replace(/\D/g, ""), 10);
    const numB = parseInt(b.id.replace(/\D/g, ""), 10);
    cmp = isNaN(numA) || isNaN(numB) ? a.id.localeCompare(b.id) : numA - numB;
  }
  return dir === "asc" ? cmp : -cmp;
}

// ---------------------------------------------------------------------------
// Inner widget (hooks after payload guard)
// ---------------------------------------------------------------------------

function TaskListInner({ tasks }: { tasks: TaskListItem[] }) {
  const filterFn = useCallback(taskFilterFn, []);
  const sortFn = useCallback(taskSortFn, []);

  const kinds = [...new Set(tasks.map((t) => t.kind))].sort();

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
  } = useListControls<TaskListItem, TaskSortKey, TaskFilters>({
    items: tasks,
    defaultPageSize: 25,
    defaultSortKey: "id",
    defaultSortDir: "desc",
    defaultFilters: DEFAULT_FILTERS,
    filterFn,
    sortFn,
    pageSizeOptions: [25, 50, 100],
    prefix: "tl",
  });

  return (
    <>
      {totalCount > 0 && (
        <TaskListControlBar
          sortKey={sortKey}
          sortDir={sortDir}
          filters={filters}
          pageSize={pageSize}
          pageSizeOptions={pageSizeOptions}
          hasActiveFilters={hasActiveFilters}
          kinds={kinds}
          onSort={setSort}
          onFilterStatus={(v) => setFilter("status", v)}
          onFilterSearch={(v) => setFilter("search", v)}
          onFilterKind={(v) => setFilter("kind", v)}
          onPageSize={setPageSize}
          onClearFilters={clearFilters}
        />
      )}

      {totalCount === 0 ? (
        <p className="text-sm text-muted-foreground">No tasks</p>
      ) : filteredCount === 0 ? (
        <div className="py-6 text-center">
          <p className="text-sm text-muted-foreground">No tasks match these filters</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            className="mt-2 text-xs"
          >
            Clear filters
          </Button>
        </div>
      ) : (
        <div>
          <TaskTableHeader sortKey={sortKey} sortDir={sortDir} onSort={setSort} />
          {pageItems.map((task) => (
            <TaskRowItem key={task.id} task={task} />
          ))}
          <PaginationBar
            page={page}
            pageCount={pageCount}
            filteredCount={filteredCount}
            totalCount={totalCount}
            onPage={setPage}
          />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main widget component — self-fetching via TanStack Query
// ---------------------------------------------------------------------------

export function TaskList() {
  const query = useQuery<WidgetData, Error>({
    queryKey: ["task-list"],
    queryFn: fetchTaskList,
    staleTime: 30_000,
    refetchInterval: 10_000,
  });

  if (query.isError) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Tasks</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          <p>Failed to load tasks: {query.error.message}</p>
        </CardContent>
      </Card>
    );
  }

  if (query.isLoading || !query.data) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Tasks</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          <p>Loading…</p>
        </CardContent>
      </Card>
    );
  }

  const data = query.data;

  if (data.state === "degraded") {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Tasks</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          <p>{data.reason}</p>
        </CardContent>
      </Card>
    );
  }

  if (!isTaskListPayload(data.payload)) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold">Tasks</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          <p>Unexpected payload shape</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold">Tasks</CardTitle>
      </CardHeader>
      <CardContent>
        <TaskListInner tasks={data.payload.tasks} />
      </CardContent>
    </Card>
  );
}

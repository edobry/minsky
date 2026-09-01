/**
 * TaskList widget frontend (mt#2078)
 *
 * Flat sortable/filterable table of all tasks. Self-fetching via TanStack
 * Query. Complements the TaskGraph DAG view with a scan-friendly list.
 *
 * Uses useListControls with prefix "tl" for URL param persistence.
 * Status filter is multi-select via comma-separated URL param values.
 *
 * mt#2919 tasks-page pass:
 *  - The legacy off-state-machine status pill (never part of the canonical
 *    TODO -> PLANNING -> READY -> IN-PROGRESS -> IN-REVIEW -> DONE machine,
 *    side states BLOCKED/CLOSED) is retired — a tasks_list(all:true) probe
 *    on 2026-07-18 confirmed zero live tasks carry it; see status-colors.ts
 *    and the PR body for the full probe transcript.
 *  - Default sort foregrounds the supervision loop (IN-REVIEW/BLOCKED/
 *    IN-PROGRESS above READY above PLANNING above TODO above the settled
 *    DONE/CLOSED tail) instead of raw ID-desc, per /product-thinking's
 *    "what is the state of the work?" framing. Explicit sort overrides
 *    (clicking a column, a bookmarked ?tl_sort= URL) still win —
 *    useListControls reads the URL before falling back to these defaults.
 *  - Structural labels (control-bar row labels, table column headers) adopt
 *    the docs/design-system.md §2 `eyebrow` type token + `font-mono` +
 *    `uppercase` (brand-system.md §1's "Eyebrows ... -> JetBrains Mono"
 *    register). Table-cell/badge text migrates text-xs -> text-small,
 *    row-title text-sm -> text-body — same pixel sizes, named tokens.
 */
import { useCallback, useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Button } from "../components/ui/button";
import { WidgetShell, type WidgetVariant } from "../components/WidgetShell";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { useListControls, readListControlsState, type SortDir } from "../lib/useListControls";
import { SortIndicator } from "../components/SortIndicator";
import { statusStyle } from "../lib/status-colors";
import {
  useProject,
  shouldShowProjectIndicator,
  projectLabelBySlug,
  type ProjectSummary,
} from "../lib/project-context";
import { ProjectBadge } from "../components/ProjectBadge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

// ---------------------------------------------------------------------------
// Types — mirror of server TaskListItem / TaskListPayload
// ---------------------------------------------------------------------------

export interface TaskListItem {
  id: string;
  title: string;
  status: string;
  kind: string;
  tags: string[];
  parentId: string | null;
  /** Owning project's slug, or null for a legacy/unscoped row (mt#4729 SC1). */
  project: string | null;
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

async function fetchTaskList(
  queryParam?: { project: string },
  includeTerminal = false
): Promise<WidgetData> {
  return fetchWidgetData(
    "task-list",
    includeTerminal ? { ...queryParam, includeTerminal: "true" } : queryParam
  );
}

/**
 * Statuses the widget payload omits unless asked (mt#4774) — see the
 * `includeTerminal` branch in `src/cockpit/widgets/task-list.ts`. Selecting one
 * of these is what makes the page request the larger set.
 */
const TERMINAL_STATUSES = new Set(["DONE", "CLOSED"]);

/** True when the status filter selects a status the default payload excludes. */
export function selectionNeedsTerminal(statusFilter: string): boolean {
  for (const status of parseStatusFilter(statusFilter)) {
    if (TERMINAL_STATUSES.has(status)) return true;
  }
  return false;
}

/**
 * Read the current URL's status filter and decide whether the widened payload
 * is needed (mt#4774). Non-reactive by design — callers pair it with mount
 * state and a `popstate` listener; `readListControlsState` exists for exactly
 * this "need the filter before the hook that owns it" ordering (mt#4762).
 */
function readIncludeTerminalFromUrl(): boolean {
  return selectionNeedsTerminal(
    readListControlsState<TaskSortKey, TaskFilters>({
      defaultPageSize: 25,
      defaultSortKey: "status",
      defaultSortDir: "asc",
      defaultFilters: DEFAULT_FILTERS,
      prefix: "tl",
    }).filters.status
  );
}

// ---------------------------------------------------------------------------
// Sort / filter config
// ---------------------------------------------------------------------------

export type TaskSortKey = "id" | "title" | "status" | "kind";

type TaskFilters = {
  /** Comma-separated status values for multi-select, or "all" */
  status: string;
  search: string;
  kind: string;
};

const DEFAULT_FILTERS: TaskFilters = {
  status: "all",
  search: "",
  kind: "all",
};

function parseStatusFilter(raw: string): Set<string> {
  if (raw === "all" || raw === "") return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );
}

function toggleStatus(current: string, status: string): string {
  const selected = parseStatusFilter(current);
  if (selected.has(status)) {
    selected.delete(status);
  } else {
    selected.add(status);
  }
  return selected.size === 0 ? "all" : [...selected].join(",");
}

// ---------------------------------------------------------------------------
// Status badge — colors come from the shared ../lib/status-colors module
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const s = statusStyle(status);
  return (
    <span
      className="text-small px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap"
      style={{ background: s.background, color: s.color, border: `1px solid ${s.border}` }}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Supervision-loop status ordering (mt#2919)
//
// The default view answers "what is the state of the work?", not "what row
// was inserted last?" (/product-thinking framing). Sorting the Status column
// alphabetically (BLOCKED, CLOSED, DONE, IN-PROGRESS, IN-REVIEW, PLANNING,
// READY, TODO) buries the active working set under an alphabetically-early
// cluster. This priority order instead foregrounds what needs the operator's
// attention now: IN-REVIEW/BLOCKED/IN-PROGRESS (the active supervision loop)
// above READY (queued to start) above PLANNING (being scoped) above TODO
// (backlog) above the settled DONE/CLOSED tail.
// ---------------------------------------------------------------------------

// Priority for statuses not present in STATUS_SORT_PRIORITY — matches TODO's
// rank (unrecognized statuses sort alongside not-yet-started work). Kept as a
// standalone constant (rather than re-reading STATUS_SORT_PRIORITY.TODO) so
// the fallback in statusPriority() below is a plain number, not another
// indexed access into a Record<string, number> (which would itself be
// `number | undefined` under noUncheckedIndexedAccess).
const STATUS_SORT_PRIORITY_UNKNOWN = 5;

export const STATUS_SORT_PRIORITY: Record<string, number> = {
  "IN-REVIEW": 0,
  BLOCKED: 1,
  "IN-PROGRESS": 2,
  READY: 3,
  PLANNING: 4,
  TODO: STATUS_SORT_PRIORITY_UNKNOWN,
  DONE: 6,
  CLOSED: 7,
};

export function statusPriority(status: string): number {
  return STATUS_SORT_PRIORITY[status.toUpperCase()] ?? STATUS_SORT_PRIORITY_UNKNOWN;
}

// ---------------------------------------------------------------------------
// All known statuses for the filter dropdown
//
// The legacy off-state-machine status pill is retired (mt#2919) — it was
// never part of the canonical state machine (TODO -> PLANNING -> READY ->
// IN-PROGRESS -> IN-REVIEW -> DONE, side states BLOCKED/CLOSED). A
// tasks_list(all:true) probe confirmed zero live tasks carry it; see
// status-colors.ts and the PR body for the full probe transcript.
//
// Mirrors status-colors.ts's TaskStatus union (and, transitively,
// packages/domain/src/tasks/taskConstants.ts's TASK_STATUS_VALUES) — NOT
// imported from @minsky/domain for the same reason documented on that type:
// a probed vite build either hard-fails (taskConstants.ts's `crypto`
// dependency) or bloats this page's chunk by tens of KB (workflows.ts's tool-
// mapping tables) for a status list that only changes with the state machine
// itself. Update this list alongside status-colors.ts and the domain enum if
// a status is ever added/removed (mt#3010).
// ---------------------------------------------------------------------------

export const ALL_STATUSES = [
  "TODO",
  "PLANNING",
  "READY",
  "IN-PROGRESS",
  "IN-REVIEW",
  "DONE",
  "BLOCKED",
  "CLOSED",
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
  onToggleStatus: (status: string) => void;
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
  onToggleStatus,
  onFilterSearch,
  onFilterKind,
  onPageSize,
  onClearFilters,
}: ControlBarProps) {
  const selectedStatuses = parseStatusFilter(filters.status);
  // aria-labelledby targets. useId, not literal ids: "Per page:" labels exist
  // in several control bars (Agents, Workstreams), so a fixed id would collide
  // if two ever render on one page.
  const kindLabelId = useId();
  const pageSizeLabelId = useId();

  return (
    <div className="flex flex-col gap-2 py-2 mb-2 border-b border-border">
      {/* Row 1: sort + search + page size */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-eyebrow font-mono uppercase text-muted-foreground mr-1">Sort:</span>
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

        <span className="text-eyebrow font-mono uppercase text-muted-foreground">Search:</span>
        <input
          type="text"
          value={filters.search}
          onChange={(e) => onFilterSearch(e.target.value)}
          placeholder="title or ID..."
          className="text-xs bg-background border border-border rounded px-1.5 py-1 w-32 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
          aria-label="Search tasks by title or ID"
        />

        {/* Kind filter */}
        {kinds.length > 1 && (
          <>
            <span
              id={kindLabelId}
              className="text-eyebrow font-mono uppercase text-muted-foreground ml-1"
            >
              Kind:
            </span>
            <Select value={filters.kind} onValueChange={onFilterKind}>
              <SelectTrigger
                className="h-6 bg-background"
                aria-labelledby={kindLabelId}
                title="Filter by kind"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {kinds.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}

        <span className="text-border mx-1">|</span>

        <span
          id={pageSizeLabelId}
          className="text-eyebrow font-mono uppercase text-muted-foreground"
        >
          Per page:
        </span>
        <Select value={String(pageSize)} onValueChange={(v) => onPageSize(Number(v))}>
          <SelectTrigger
            className="h-6 bg-background"
            aria-labelledby={pageSizeLabelId}
            title="Items per page"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {pageSizeOptions.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

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

      {/* Row 2: status multi-select toggle pills */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-eyebrow font-mono uppercase text-muted-foreground mr-1">Status:</span>
        {ALL_STATUSES.map((s) => {
          const isSelected = selectedStatuses.has(s);
          const style = statusStyle(s);
          return (
            <button
              key={s}
              onClick={() => onToggleStatus(s)}
              className="text-small px-1.5 py-0.5 rounded-full font-medium transition-opacity"
              style={{
                background: isSelected ? style.background : "transparent",
                color: isSelected ? style.color : style.background,
                border: `1px solid ${style.border}`,
                opacity: selectedStatuses.size === 0 || isSelected ? 1 : 0.4,
              }}
              aria-pressed={isSelected}
              aria-label={`Filter by ${s}`}
            >
              {s}
            </button>
          );
        })}
      </div>
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
      <span className="text-small text-muted-foreground">
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
          <span className="text-small text-muted-foreground px-1 tabular-nums">
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
        className="text-eyebrow font-mono uppercase text-muted-foreground flex-shrink-0 w-24 text-left hover:text-foreground transition-colors"
      >
        Status
        <SortIndicator active={sortKey === "status"} dir={sortDir} />
      </button>
      <button
        onClick={() => onSort("id")}
        className="text-eyebrow font-mono uppercase text-muted-foreground flex-shrink-0 w-20 text-left hover:text-foreground transition-colors"
      >
        ID
        <SortIndicator active={sortKey === "id"} dir={sortDir} />
      </button>
      <button
        onClick={() => onSort("title")}
        className="flex-1 text-eyebrow font-mono uppercase text-muted-foreground text-left hover:text-foreground transition-colors"
      >
        Title
        <SortIndicator active={sortKey === "title"} dir={sortDir} />
      </button>
      <button
        onClick={() => onSort("kind")}
        className="text-eyebrow font-mono uppercase text-muted-foreground flex-shrink-0 w-28 text-left hover:text-foreground transition-colors"
      >
        Kind
        <SortIndicator active={sortKey === "kind"} dir={sortDir} />
      </button>
      <span className="text-eyebrow font-mono uppercase text-muted-foreground flex-shrink-0 w-16 text-left">
        Parent
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task row — navigates to /tasks/:id on click
// ---------------------------------------------------------------------------

function TaskRowItem({
  task,
  showProjectBadge,
  projects,
}: {
  task: TaskListItem;
  /** Whether the project indicator is worth rendering at all — see `shouldShowProjectIndicator`. */
  showProjectBadge: boolean;
  projects: ProjectSummary[];
}) {
  const projectLabel = showProjectBadge ? projectLabelBySlug(projects, task.project) : null;
  return (
    <div className="border-b border-border last:border-0">
      <Link
        to={`/tasks/${encodeURIComponent(task.id)}`}
        className="flex items-center gap-3 py-1.5 w-full text-left hover:bg-muted/30 transition-colors rounded-sm"
      >
        <div className="flex-shrink-0 w-24">
          <StatusBadge status={task.status} />
        </div>
        <span className="text-small font-mono text-muted-foreground flex-shrink-0 w-20">
          {task.id}
        </span>
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="text-body truncate">{task.title}</span>
          {projectLabel && <ProjectBadge label={projectLabel} className="flex-shrink-0" />}
        </div>
        <span className="text-small text-muted-foreground flex-shrink-0 w-28 truncate">
          {task.kind}
        </span>
        <span className="text-small font-mono text-muted-foreground flex-shrink-0 w-16">
          {task.parentId ?? "—"}
        </span>
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter / sort functions
// ---------------------------------------------------------------------------

function taskFilterFn(task: TaskListItem, filters: TaskFilters): boolean {
  const selectedStatuses = parseStatusFilter(filters.status);
  if (selectedStatuses.size > 0 && !selectedStatuses.has(task.status.toUpperCase())) {
    return false;
  }
  if (filters.kind !== "all" && task.kind !== filters.kind) {
    return false;
  }
  if (filters.search.trim() !== "") {
    const needle = filters.search.trim().toLowerCase();
    if (!task.title.toLowerCase().includes(needle) && !task.id.toLowerCase().includes(needle)) {
      return false;
    }
  }
  return true;
}

export function taskSortFn(
  a: TaskListItem,
  b: TaskListItem,
  key: TaskSortKey,
  dir: SortDir
): number {
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
      // mt#2919: workflow/supervision-priority order, not alphabetical —
      // see STATUS_SORT_PRIORITY above.
      cmp = statusPriority(a.status) - statusPriority(b.status);
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

function TaskListInner({
  tasks,
  showProjectBadge,
  projects,
  onIncludeTerminalChange,
}: {
  tasks: TaskListItem[];
  showProjectBadge: boolean;
  projects: ProjectSummary[];
  onIncludeTerminalChange: (needed: boolean) => void;
}) {
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
    // mt#2919: default to the supervision-loop ordering (status priority,
    // ascending) instead of raw ID-desc — see STATUS_SORT_PRIORITY above.
    // Explicit overrides (a click on any column header, or a bookmarked
    // ?tl_sort=/?tl_dir= URL) still win — useListControls reads the URL
    // before falling back to these defaults.
    defaultSortKey: "status",
    defaultSortDir: "asc",
    defaultFilters: DEFAULT_FILTERS,
    filterFn,
    sortFn,
    // Pre-existing override of useListControls' shared DEFAULT_PAGE_SIZE_OPTIONS
    // ([10, 25, 50]) — predates mt#2919, unchanged by this PR. Justification
    // (per reviewer request): the task backlog routinely runs into the
    // hundreds (the mt#2919 COMPLETED probe's tasks_list(all:true) dump alone
    // covered ~700 tasks), so a higher page-size ceiling reduces pagination
    // clicks for an operator scanning the full backlog; 10 as a floor is too
    // small to be useful for a list this size.
    pageSizeOptions: [25, 50, 100],
    prefix: "tl",
  });

  const handleToggleStatus = useCallback(
    (status: string) => {
      const next = toggleStatus(filters.status, status);
      // Report the fetch-shape change in the SAME event as the filter change
      // (PR #3530 R2), not a render later via the effect below. Otherwise the
      // click produces one render where the new filter is applied to the old
      // active-only payload, which shows "No tasks match these filters" — a
      // flash of the exact misleading message this task removes. Updating the
      // parent here changes the query key in the same batch, so that render
      // never happens: TanStack has no data for the new key and the body's
      // own loading branch covers the gap.
      onIncludeTerminalChange(selectionNeedsTerminal(next));
      setFilter("status", next);
    },
    [filters.status, setFilter, onIncludeTerminalChange]
  );

  // Backstop for filter changes that do NOT come through the toggle handler
  // above — `clearFilters`, and any future control that writes the status
  // filter (mt#4774). Effect rather than a call during render: it sets state
  // in the parent, which React forbids mid-render. Idempotent, and a no-op on
  // mount for the common case because the parent seeds itself from the URL.
  const needsTerminal = selectionNeedsTerminal(filters.status);
  useEffect(() => {
    onIncludeTerminalChange(needsTerminal);
  }, [needsTerminal, onIncludeTerminalChange]);

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
          onToggleStatus={handleToggleStatus}
          onFilterSearch={(v) => setFilter("search", v)}
          onFilterKind={(v) => setFilter("kind", v)}
          onPageSize={setPageSize}
          onClearFilters={clearFilters}
        />
      )}

      {totalCount === 0 ? (
        <p className="text-body text-muted-foreground">No tasks</p>
      ) : filteredCount === 0 ? (
        <div className="py-6 text-center">
          <p className="text-body text-muted-foreground">No tasks match these filters</p>
          <Button variant="ghost" size="sm" onClick={clearFilters} className="mt-2 text-xs">
            Clear filters
          </Button>
        </div>
      ) : (
        <div>
          <TaskTableHeader sortKey={sortKey} sortDir={sortDir} onSort={setSort} />
          {pageItems.map((task) => (
            <TaskRowItem
              key={task.id}
              task={task}
              showProjectBadge={showProjectBadge}
              projects={projects}
            />
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
// Chrome-agnostic body — no Card/CardHeader/CardTitle in any branch
// ---------------------------------------------------------------------------

interface TaskListBodyProps {
  query: UseQueryResult<WidgetData, Error>;
  showProjectBadge: boolean;
  projects: ProjectSummary[];
  /**
   * Report whether the status filter selects a terminal status, so the fetch
   * above can request the payload that contains them (mt#4774). Passed
   * through to `TaskListInner`, which owns the filter state.
   */
  onIncludeTerminalChange: (needed: boolean) => void;
}

function TaskListBody({
  query,
  showProjectBadge,
  projects,
  onIncludeTerminalChange,
}: TaskListBodyProps) {
  if (query.isError) {
    return (
      <p className="text-muted-foreground text-body">Failed to load tasks: {query.error.message}</p>
    );
  }
  if (query.isLoading || !query.data) {
    return <p className="text-muted-foreground text-body">Loading…</p>;
  }

  const data = query.data;

  if (data.state === "degraded") {
    return <p className="text-muted-foreground text-body">{data.reason}</p>;
  }
  if (!isTaskListPayload(data.payload)) {
    return <p className="text-muted-foreground text-body">Unexpected payload shape</p>;
  }

  return (
    <TaskListInner
      tasks={data.payload.tasks}
      showProjectBadge={showProjectBadge}
      projects={projects}
      onIncludeTerminalChange={onIncludeTerminalChange}
    />
  );
}

// ---------------------------------------------------------------------------
// Main widget component — self-fetching via TanStack Query (mt#2373)
// ---------------------------------------------------------------------------

interface TaskListProps {
  /** Render-context variant; defaults to the home-grid card frame. */
  variant?: WidgetVariant;
  /** Title from the registry; defaults to the widget's canonical title for back-compat. */
  title?: string;
}

export function TaskList({ variant = "card", title = "Tasks" }: TaskListProps = {}) {
  const { selectedSlug, queryParam, projects } = useProject();
  // Whether the operator's status filter currently selects a terminal status
  // (mt#4774). The filter itself lives in `TaskListBody` — `useListControls`
  // needs the fetched `items` — and it persists to the URL via
  // `history.replaceState`, which fires no event, so a parent cannot observe
  // it by subscription. The body reports the one derived bit up instead;
  // keeping the full control state below the fetch avoids restructuring the
  // widget around a single flag.
  //
  // The INITIAL value is read straight off the URL rather than defaulting to
  // false, so a deep link or reload carrying ?tl_status=DONE fetches the right
  // set on the first request instead of rendering an empty table and
  // correcting itself a round-trip later. `readListControlsState` exists for
  // exactly this ordering (mt#4762): a non-reactive read for callers that must
  // build a query before the hook's own state exists.
  const [includeTerminal, setIncludeTerminal] = useState(readIncludeTerminalFromUrl);

  // Browser back/forward changes the filter without re-mounting, and the
  // child's report-up runs a render later — so without this the first fetch
  // after a history navigation goes out with the previous flag and is then
  // re-issued (PR #3530 R1). `useListControls` subscribes to `popstate` for
  // the same reason; this mirrors it for the one bit the fetch depends on.
  useEffect(() => {
    const onPopState = () => setIncludeTerminal(readIncludeTerminalFromUrl());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const query = useQuery<WidgetData, Error>({
    // mt#2418: selectedSlug in the key so switching projects invalidates
    // the cache and refetches immediately rather than waiting out staleTime.
    // mt#4774: includeTerminal too, so the active-only and with-terminal
    // payloads cache separately — toggling DONE off then on again re-reads
    // the cached set instead of re-fetching ~4.7k rows.
    queryKey: ["task-list", selectedSlug, includeTerminal],
    queryFn: () => fetchTaskList(queryParam, includeTerminal),
    staleTime: 30_000,
    refetchInterval: 10_000,
  });
  // mt#4729: suppressed when a single project is selected or only one
  // project exists — see shouldShowProjectIndicator's doc comment.
  const showProjectBadge = shouldShowProjectIndicator(projects, selectedSlug);

  return (
    <WidgetShell variant={variant} title={title}>
      <TaskListBody
        query={query}
        showProjectBadge={showProjectBadge}
        projects={projects}
        onIncludeTerminalChange={setIncludeTerminal}
      />
    </WidgetShell>
  );
}

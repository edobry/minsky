/**
 * Workstreams widget frontend (mt#1452, mt#1924)
 *
 * Collapsible card view of active workstreams: one card per parent task that
 * has at least one non-terminal child. Each card shows:
 *  - Parent task ID + title in the header
 *  - Active / done / blocked child counts as a pill
 *  - Expand/collapse chevron (default: all open when ≤5 workstreams, collapsed otherwise)
 *  - Child rows with status badges when expanded
 *
 * mt#1924: Added pagination, sorting, and filtering controls with URL param
 * persistence. Controls use prefix "ws" to namespace params.
 *
 * Status color palette duplicated from TaskGraph.tsx — centralization is a
 * separate refactor concern per mt#1146 review feedback.
 */
import { useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { WidgetShell, type WidgetVariant } from "../components/WidgetShell";
import { useListControls, type SortDir } from "../lib/useListControls";

// ---------------------------------------------------------------------------
// Types — inline mirror of the server WorkstreamCard / WorkstreamsPayload shapes.
// Frontend must stay self-contained (no server imports).
// Keep in sync with src/cockpit/widgets/workstreams.ts.
// ---------------------------------------------------------------------------

type TaskStatus =
  | "TODO"
  | "READY"
  | "IN-PROGRESS"
  | "IN-REVIEW"
  | "DONE"
  | "BLOCKED"
  | "CLOSED"
  | "PLANNING";

interface WorkstreamChild {
  id: string;
  title: string;
  status: TaskStatus;
}

interface WorkstreamCard {
  parentId: string;
  parentTitle: string;
  parentStatus: TaskStatus;
  children: WorkstreamChild[];
  activeChildCount: number;
  doneChildCount: number;
  blockedChildCount: number;
}

interface WorkstreamsPayload {
  workstreams: WorkstreamCard[];
}

type WidgetData = { state: "ok"; payload: unknown } | { state: "degraded"; reason: string };

interface Props {
  data: WidgetData;
  /** Render-context variant; defaults to the home-grid card frame. */
  variant?: WidgetVariant;
  /** Title from the registry; defaults to the widget's canonical title for back-compat. */
  title?: string;
}

// ---------------------------------------------------------------------------
// Sort / filter config
// ---------------------------------------------------------------------------

type WorkstreamSortKey = "activeChildCount" | "parentId" | "age";

interface WorkstreamFilters {
  status: "all" | "active" | "done" | "blocked";
  minActiveChildren: string; // URL params are always strings; parse to int when comparing
}

const DEFAULT_FILTERS: WorkstreamFilters = {
  status: "all",
  minActiveChildren: "0",
};

// ---------------------------------------------------------------------------
// Status badge helpers
// Duplicated from TaskGraph.tsx — palette mirrors "tech-tree" style from
// deps-rendering-graphviz.ts. Centralization is a separate refactor concern.
// ---------------------------------------------------------------------------

interface StatusStyle {
  background: string;
  border: string;
  color: string;
}

function statusStyle(status: TaskStatus): StatusStyle {
  switch (status) {
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
    case "TODO":
    default:
      return { background: "#e2e8f0", border: "#64748b", color: "#1e293b" };
  }
}

function StatusBadge({ status }: { status: TaskStatus }) {
  const s = statusStyle(status);
  return (
    <span
      className="text-xs px-1.5 py-0.5 rounded-full font-medium flex-shrink-0"
      style={{ background: s.background, color: s.color, border: `1px solid ${s.border}` }}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Chevron icon component
// ---------------------------------------------------------------------------

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
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
// Control bar
// ---------------------------------------------------------------------------

interface ControlBarProps {
  sortKey: WorkstreamSortKey;
  sortDir: SortDir;
  filters: WorkstreamFilters;
  pageSize: number;
  pageSizeOptions: number[];
  hasActiveFilters: boolean;
  onSort: (key: WorkstreamSortKey) => void;
  onFilterStatus: (value: WorkstreamFilters["status"]) => void;
  onFilterMinActive: (value: string) => void;
  onPageSize: (size: number) => void;
  onClearFilters: () => void;
}

function WorkstreamsControlBar({
  sortKey,
  sortDir,
  filters,
  pageSize,
  pageSizeOptions,
  hasActiveFilters,
  onSort,
  onFilterStatus,
  onFilterMinActive,
  onPageSize,
  onClearFilters,
}: ControlBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 py-2 mb-3 border-b border-border">
      {/* Sort controls */}
      <span className="text-xs text-muted-foreground uppercase tracking-wide mr-1">Sort:</span>
      <button
        onClick={() => onSort("activeChildCount")}
        className={`text-xs px-2 py-1 rounded border transition-colors ${
          sortKey === "activeChildCount"
            ? "border-primary bg-primary/10 text-foreground"
            : "border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground"
        }`}
        aria-pressed={sortKey === "activeChildCount"}
      >
        Active
        <SortIndicator active={sortKey === "activeChildCount"} dir={sortDir} />
      </button>
      <button
        onClick={() => onSort("parentId")}
        className={`text-xs px-2 py-1 rounded border transition-colors ${
          sortKey === "parentId"
            ? "border-primary bg-primary/10 text-foreground"
            : "border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground"
        }`}
        aria-pressed={sortKey === "parentId"}
      >
        ID
        <SortIndicator active={sortKey === "parentId"} dir={sortDir} />
      </button>

      <span className="text-border mx-1">|</span>

      {/* Status filter */}
      <span className="text-xs text-muted-foreground uppercase tracking-wide mr-1">Status:</span>
      <select
        value={filters.status}
        onChange={(e) => onFilterStatus(e.target.value as WorkstreamFilters["status"])}
        className="text-xs bg-background border border-border rounded px-1.5 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        aria-label="Filter by status"
      >
        <option value="all">All</option>
        <option value="active">Active</option>
        <option value="done">Done</option>
        <option value="blocked">Blocked</option>
      </select>

      {/* Min active children filter */}
      <span className="text-xs text-muted-foreground ml-1">Min active:</span>
      <input
        type="number"
        min={0}
        max={999}
        value={filters.minActiveChildren}
        onChange={(e) => onFilterMinActive(e.target.value)}
        className="text-xs bg-background border border-border rounded px-1.5 py-1 w-14 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        aria-label="Minimum active children"
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
          <option key={n} value={n}>
            {n}
          </option>
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
    <div className="flex items-center justify-between pt-3 mt-2 border-t border-border">
      <span className="text-xs text-muted-foreground">
        {filteredCount === totalCount
          ? `${totalCount} workstream${totalCount === 1 ? "" : "s"}`
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
// Workstream card component
// ---------------------------------------------------------------------------

interface WorkstreamCardProps {
  card: WorkstreamCard;
  defaultOpen: boolean;
}

function WorkstreamCardItem({ card, defaultOpen }: WorkstreamCardProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <Card className="mb-3 last:mb-0">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm">
              <Link
                to={`/tasks/${encodeURIComponent(card.parentId)}`}
                className="font-mono text-xs text-muted-foreground mr-1 hover:text-foreground transition-colors"
                onClick={(e) => e.stopPropagation()}
              >
                {card.parentId}
              </Link>
              <span className="font-medium">{card.parentTitle}</span>
            </CardTitle>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Counts pill */}
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {card.activeChildCount} active
              {card.doneChildCount > 0 && ` · ${card.doneChildCount} done`}
              {card.blockedChildCount > 0 && ` · ${card.blockedChildCount} blocked`}
            </span>
            {/* Expand/collapse button */}
            <button
              onClick={() => setIsOpen((prev) => !prev)}
              className="text-muted-foreground hover:text-foreground p-1 rounded"
              aria-label={isOpen ? "Collapse workstream" : "Expand workstream"}
            >
              <Chevron open={isOpen} />
            </button>
          </div>
        </div>
      </CardHeader>

      {isOpen && (
        <CardContent className="pt-0">
          {card.children.map((child) => (
            <Link
              key={child.id}
              to={`/tasks/${encodeURIComponent(child.id)}`}
              className="flex items-center gap-2 py-1.5 border-b border-border last:border-0 hover:bg-muted/30 transition-colors rounded-sm"
            >
              <StatusBadge status={child.status} />
              <span className="text-xs font-mono text-muted-foreground flex-shrink-0">
                {child.id}
              </span>
              <span className="text-sm truncate">{child.title}</span>
            </Link>
          ))}
        </CardContent>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Filter / sort functions
// ---------------------------------------------------------------------------

function workstreamFilterFn(card: WorkstreamCard, filters: WorkstreamFilters): boolean {
  // Status filter
  if (filters.status !== "all") {
    const hasActive = card.activeChildCount > 0;
    const hasDone = card.doneChildCount > 0 && card.activeChildCount === 0;
    const hasBlocked = card.blockedChildCount > 0;
    if (filters.status === "active" && !hasActive) return false;
    if (filters.status === "done" && !hasDone) return false;
    if (filters.status === "blocked" && !hasBlocked) return false;
  }

  // Min active children filter
  const minActive = parseInt(filters.minActiveChildren, 10);
  if (!isNaN(minActive) && minActive > 0 && card.activeChildCount < minActive) {
    return false;
  }

  return true;
}

function workstreamSortFn(
  a: WorkstreamCard,
  b: WorkstreamCard,
  key: WorkstreamSortKey,
  dir: SortDir
): number {
  let cmp = 0;
  switch (key) {
    case "activeChildCount":
      cmp = a.activeChildCount - b.activeChildCount;
      break;
    case "parentId": {
      // Sort mt#NNNN numerically
      const numA = parseInt(a.parentId.replace(/\D/g, ""), 10);
      const numB = parseInt(b.parentId.replace(/\D/g, ""), 10);
      cmp = isNaN(numA) || isNaN(numB) ? a.parentId.localeCompare(b.parentId) : numA - numB;
      break;
    }
    case "age":
    default:
      cmp = 0;
      break;
  }
  return dir === "asc" ? cmp : -cmp;
}

// ---------------------------------------------------------------------------
// Chrome-agnostic body — no widget-level Card/CardHeader/CardTitle
// (WorkstreamCardItem's inner Cards are child item chrome, not widget chrome)
// ---------------------------------------------------------------------------

interface WorkstreamsBodyProps {
  data: WidgetData;
}

function WorkstreamsBody({ data }: WorkstreamsBodyProps) {
  if (data.state === "degraded") {
    return <p className="text-sm text-muted-foreground">{data.reason}</p>;
  }

  const payload = data.payload as WorkstreamsPayload;
  const workstreams = payload.workstreams ?? [];

  return <WorkstreamsInner workstreams={workstreams} />;
}

// Inner component so hooks run after the early-return guard
function WorkstreamsInner({ workstreams }: { workstreams: WorkstreamCard[] }) {
  const filterFn = useCallback(workstreamFilterFn, []);
  const sortFn = useCallback(workstreamSortFn, []);

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
  } = useListControls<WorkstreamCard, WorkstreamSortKey, WorkstreamFilters>({
    items: workstreams,
    defaultPageSize: 10,
    defaultSortKey: "activeChildCount",
    defaultSortDir: "desc",
    defaultFilters: DEFAULT_FILTERS,
    filterFn,
    sortFn,
    pageSizeOptions: [10, 25, 50],
    prefix: "ws",
  });

  // Default expand/collapse: all open when ≤5 on this page, all collapsed if >5
  const defaultOpen = pageItems.length <= 5;

  return (
    <>
      {/* Count line — was in the CardTitle; now a subtitle below WidgetShell's title */}
      {totalCount > 0 && (
        <p className="text-xs text-muted-foreground mb-2">
          {filteredCount === totalCount ? totalCount : `${filteredCount}/${totalCount}`} active
        </p>
      )}

      {/* Controls — always render when there are workstreams */}
      {totalCount > 0 && (
        <WorkstreamsControlBar
          sortKey={sortKey}
          sortDir={sortDir}
          filters={filters}
          pageSize={pageSize}
          pageSizeOptions={pageSizeOptions}
          hasActiveFilters={hasActiveFilters}
          onSort={setSort}
          onFilterStatus={(v) => setFilter("status", v)}
          onFilterMinActive={(v) => setFilter("minActiveChildren", v)}
          onPageSize={setPageSize}
          onClearFilters={clearFilters}
        />
      )}

      {/* Content */}
      {totalCount === 0 ? (
        <p className="text-sm text-muted-foreground">No active workstreams</p>
      ) : filteredCount === 0 ? (
        <div className="py-6 text-center">
          <p className="text-sm text-muted-foreground">No workstreams match these filters</p>
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
          {pageItems.map((card) => (
            <WorkstreamCardItem key={card.parentId} card={card} defaultOpen={defaultOpen} />
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
// Main widget export (mt#2373)
// ---------------------------------------------------------------------------

export function Workstreams({ data, variant = "card", title = "Workstreams" }: Props) {
  return (
    <WidgetShell variant={variant} title={title}>
      <WorkstreamsBody data={data} />
    </WidgetShell>
  );
}

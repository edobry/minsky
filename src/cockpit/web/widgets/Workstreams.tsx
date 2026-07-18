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
 * Status colors come from the shared `../lib/status-colors` module (mt#2909
 * consolidation; previously a byte-identical raw-hex copy of TaskGraph.tsx's
 * `statusStyle()` — see mt#1146 review feedback).
 */
import { useState, useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { WidgetShell, type WidgetVariant } from "../components/WidgetShell";
import { useListControls, type SortDir } from "../lib/useListControls";
import { statusStyle, type TaskStatus } from "../lib/status-colors";
import {
  streamHealth,
  STREAM_HEALTH_RANK,
  type StreamHealth,
  type StreamHealthState,
} from "../lib/workstream-health";
import { fetchAsks, formatRelative, type AsksListResponse } from "./AskDetail";
import { useQuery } from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Types — inline mirror of the server WorkstreamCard / WorkstreamsPayload shapes.
// Frontend must stay self-contained (no server imports).
// Keep in sync with src/cockpit/widgets/workstreams.ts.
// TaskStatus itself is imported from ../lib/status-colors (a frontend-only
// module, not a server import) to avoid a second inline copy of the enum.
// ---------------------------------------------------------------------------

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
  /** Newest task updatedAt in the stream, ISO string or null (mt#2885). */
  lastActivityAt: string | null;
}

/** Semantic slice names (mt#2385) — keep in sync with workstreams.ts */
type WorkstreamAltitude = "full" | "rollup" | "actionable";

interface WorkstreamsPayload {
  workstreams: WorkstreamCard[];
  /** Slice that produced this payload; optional for back-compat with pre-mt#2385 payloads */
  altitude?: WorkstreamAltitude;
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

type WorkstreamSortKey = "attention" | "activeChildCount" | "parentId" | "age";

interface WorkstreamFilters {
  status: "all" | "active" | "done" | "blocked";
  minActiveChildren: string; // URL params are always strings; parse to int when comparing
}

const DEFAULT_FILTERS: WorkstreamFilters = {
  status: "all",
  minActiveChildren: "0",
};

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

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
        onClick={() => onSort("attention")}
        className={`text-xs px-2 py-1 rounded border transition-colors ${
          sortKey === "attention"
            ? "border-primary bg-primary/10 text-foreground"
            : "border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground"
        }`}
        aria-pressed={sortKey === "attention"}
      >
        Attention
        <SortIndicator active={sortKey === "attention"} dir={sortDir} />
      </button>
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
  health: StreamHealth;
}

function WorkstreamCardItem({ card, defaultOpen, health }: WorkstreamCardProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  // Rollup altitude returns cards without child rows — header-only card,
  // no expand affordance (mt#2385).
  const hasChildren = card.children.length > 0;

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
            {/* Supervision signals (mt#2885): health chip + needs-me rollups +
                last motion — readable without expansion. */}
            <StreamHealthChip health={health} />
            {health.openAskCount > 0 && (
              <span className="rounded bg-warn-amber/25 px-1.5 py-0.5 text-xs tabular-nums text-foreground whitespace-nowrap">
                {health.openAskCount} ask{health.openAskCount === 1 ? "" : "s"}
              </span>
            )}
            {/* Counts pill */}
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {card.activeChildCount} active
              {health.inReviewCount > 0 && ` · ${health.inReviewCount} in review`}
              {card.doneChildCount > 0 && ` · ${card.doneChildCount} done`}
              {card.blockedChildCount > 0 && ` · ${card.blockedChildCount} blocked`}
            </span>
            {card.lastActivityAt && (
              <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                {formatRelative(card.lastActivityAt)}
              </span>
            )}
            {/* Expand/collapse button */}
            {hasChildren && (
              <button
                onClick={() => setIsOpen((prev) => !prev)}
                className="text-muted-foreground hover:text-foreground p-1 rounded"
                aria-label={isOpen ? "Collapse workstream" : "Expand workstream"}
              >
                <Chevron open={isOpen} />
              </button>
            )}
          </div>
        </div>
      </CardHeader>

      {isOpen && hasChildren && (
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
// Stream health chip (mt#2885) — the supervision signal: is this stream
// moving, stuck, awaiting review, or blocked on the operator?
// ---------------------------------------------------------------------------

const HEALTH_CHIP: Record<StreamHealthState, { label: string; className: string }> = {
  "blocked-on-you": { label: "blocked on you", className: "bg-warn-amber/40 text-foreground" },
  stalled: { label: "stalled", className: "bg-warn-red/30 text-foreground" },
  "awaiting-review": { label: "in review", className: "bg-primary/15 text-foreground" },
  moving: { label: "moving", className: "bg-muted text-muted-foreground" },
};

function StreamHealthChip({ health }: { health: StreamHealth }) {
  const chip = HEALTH_CHIP[health.state];
  const label =
    health.state === "stalled" && health.daysSinceActivity != null
      ? `stalled ${health.daysSinceActivity}d`
      : chip.label;
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-medium tabular-nums flex-shrink-0 ${chip.className}`}
    >
      {label}
    </span>
  );
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

  // Needs-me join (mt#2885, same pattern as the fleet table mt#2884): open
  // asks bound by parentTaskId to the stream's parent or any child mark the
  // stream blocked-on-you. Shared ["asks"] query cache.
  const asksQuery = useQuery<AsksListResponse, Error>({
    queryKey: ["asks"],
    queryFn: fetchAsks,
    staleTime: 10_000,
    refetchInterval: 10_000,
  });
  const askTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const a of asksQuery.data?.asks ?? []) {
      if (a.parentTaskId) ids.add(a.parentTaskId);
    }
    return ids;
  }, [asksQuery.data]);

  const healthByStream = useMemo(() => {
    const m = new Map<string, StreamHealth>();
    for (const card of workstreams) {
      m.set(card.parentId, streamHealth(card, askTaskIds));
    }
    return m;
  }, [workstreams, askTaskIds]);

  // Attention sort: health rank first (blocked-on-you → stalled → in-review →
  // moving), newest motion within a rank. Other keys delegate to the
  // existing comparator.
  const sortFn = useCallback(
    (a: WorkstreamCard, b: WorkstreamCard, key: WorkstreamSortKey, dir: SortDir): number => {
      if (key === "attention") {
        const ha = healthByStream.get(a.parentId);
        const hb = healthByStream.get(b.parentId);
        const rankDiff =
          STREAM_HEALTH_RANK[ha?.state ?? "moving"] - STREAM_HEALTH_RANK[hb?.state ?? "moving"];
        if (rankDiff !== 0) return dir === "asc" ? rankDiff : -rankDiff;
        const ta = a.lastActivityAt ?? "";
        const tb = b.lastActivityAt ?? "";
        const cmp = ta.localeCompare(tb);
        return dir === "asc" ? -cmp : cmp; // newest motion first within a rank
      }
      return workstreamSortFn(a, b, key, dir);
    },
    [healthByStream]
  );

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
    defaultSortKey: "attention",
    defaultSortDir: "asc",
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
            <WorkstreamCardItem key={card.parentId} card={card} defaultOpen={defaultOpen} health={healthByStream.get(card.parentId)!} />
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
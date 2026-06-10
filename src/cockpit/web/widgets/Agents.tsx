/**
 * Agents widget frontend (mt#1145, mt#1924)
 *
 * Displays running sessions/agents in a compact table. Self-fetching via
 * TanStack Query (5-second refetch interval).
 *
 * mt#1924: Added pagination, sorting, and filtering controls with URL param
 * persistence. Controls use prefix "ag" to namespace params.
 */
import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../components/ui/button";
import { WidgetShell, type WidgetVariant } from "../components/WidgetShell";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { useListControls, type SortDir } from "../lib/useListControls";
import { Link } from "react-router-dom";

// Inline mirror of the server AgentRow shape — frontend must stay self-contained
// (no imports of server code). Keep in sync with src/cockpit/widgets/agents.ts.
interface AgentRow {
  sessionId: string;
  title: string;
  liveness: "healthy" | "idle" | "stale" | "orphaned";
  taskId: string | null;
  taskTitle: string | null;
  prNumber: number | null;
  prStatus: string | null;
  lastActivityAt: string;
  agentId: string | null;
}

interface AgentsPayload {
  agents: AgentRow[];
  totalCount: number;
}

// Narrows the shared `WidgetData` envelope to the agents-specific payload shape.
function isAgentsPayload(payload: unknown): payload is AgentsPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as { agents?: unknown }).agents) &&
    typeof (payload as { totalCount?: unknown }).totalCount === "number"
  );
}

async function fetchAgents(): Promise<WidgetData> {
  return fetchWidgetData("agents");
}

// ---------------------------------------------------------------------------
// Sort / filter config
// ---------------------------------------------------------------------------

type AgentSortKey = "lastActivityAt" | "sessionId" | "liveness";

interface AgentFilters {
  liveness: "all" | "healthy" | "idle" | "stale" | "orphaned";
  taskId: string; // empty string = no filter
}

const DEFAULT_FILTERS: AgentFilters = {
  liveness: "all",
  taskId: "",
};

// ---------------------------------------------------------------------------
// Liveness helpers
// ---------------------------------------------------------------------------

function livenessDotClass(liveness: AgentRow["liveness"]): string {
  switch (liveness) {
    case "healthy":
      return "bg-liveness-healthy";
    case "idle":
      return "bg-liveness-idle";
    case "stale":
      return "bg-liveness-stale";
    case "orphaned":
      return "bg-liveness-orphaned";
  }
}

function livenessLabel(liveness: AgentRow["liveness"]): string {
  switch (liveness) {
    case "healthy":
      return "healthy";
    case "idle":
      return "idle";
    case "stale":
      return "stale";
    case "orphaned":
      return "orphaned";
  }
}

// Numeric order for sorting: healthy > idle > stale > orphaned
const LIVENESS_ORDER: Record<AgentRow["liveness"], number> = {
  healthy: 0,
  idle: 1,
  stale: 2,
  orphaned: 3,
};

// ---------------------------------------------------------------------------
// Relative-time helper — no external dep
// ---------------------------------------------------------------------------

function formatRelative(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  if (isNaN(then)) return "unknown";

  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
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
  sortKey: AgentSortKey;
  sortDir: SortDir;
  filters: AgentFilters;
  pageSize: number;
  pageSizeOptions: number[];
  hasActiveFilters: boolean;
  onSort: (key: AgentSortKey) => void;
  onFilterLiveness: (value: AgentFilters["liveness"]) => void;
  onFilterTaskId: (value: string) => void;
  onPageSize: (size: number) => void;
  onClearFilters: () => void;
}

function AgentsControlBar({
  sortKey,
  sortDir,
  filters,
  pageSize,
  pageSizeOptions,
  hasActiveFilters,
  onSort,
  onFilterLiveness,
  onFilterTaskId,
  onPageSize,
  onClearFilters,
}: ControlBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 py-2 mb-2 border-b border-border">
      {/* Sort controls */}
      <span className="text-xs text-muted-foreground uppercase tracking-wide mr-1">Sort:</span>
      <button
        onClick={() => onSort("lastActivityAt")}
        className={`text-xs px-2 py-1 rounded border transition-colors ${
          sortKey === "lastActivityAt"
            ? "border-primary bg-primary/10 text-foreground"
            : "border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground"
        }`}
        aria-pressed={sortKey === "lastActivityAt"}
      >
        Activity
        <SortIndicator active={sortKey === "lastActivityAt"} dir={sortDir} />
      </button>
      <button
        onClick={() => onSort("liveness")}
        className={`text-xs px-2 py-1 rounded border transition-colors ${
          sortKey === "liveness"
            ? "border-primary bg-primary/10 text-foreground"
            : "border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground"
        }`}
        aria-pressed={sortKey === "liveness"}
      >
        Status
        <SortIndicator active={sortKey === "liveness"} dir={sortDir} />
      </button>

      <span className="text-border mx-1">|</span>

      {/* Liveness filter */}
      <span className="text-xs text-muted-foreground uppercase tracking-wide mr-1">Liveness:</span>
      <select
        value={filters.liveness}
        onChange={(e) => onFilterLiveness(e.target.value as AgentFilters["liveness"])}
        className="text-xs bg-background border border-border rounded px-1.5 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        aria-label="Filter by liveness"
      >
        <option value="all">All</option>
        <option value="healthy">Healthy</option>
        <option value="idle">Idle</option>
        <option value="stale">Stale</option>
        <option value="orphaned">Orphaned</option>
      </select>

      {/* Task ID filter */}
      <span className="text-xs text-muted-foreground ml-1">Task:</span>
      <input
        type="text"
        value={filters.taskId}
        onChange={(e) => onFilterTaskId(e.target.value)}
        placeholder="mt#…"
        className="text-xs bg-background border border-border rounded px-1.5 py-1 w-20 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
        aria-label="Filter by task ID"
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
    <div className="flex items-center justify-between pt-2 mt-1 border-t border-border">
      <span className="text-xs text-muted-foreground">
        {filteredCount === totalCount
          ? `${totalCount} session${totalCount === 1 ? "" : "s"}`
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
// Agent row component
// ---------------------------------------------------------------------------

function AgentRowItem({ agent }: { agent: AgentRow }) {
  const label = livenessLabel(agent.liveness);
  return (
    <Link
      to={`/session/${encodeURIComponent(agent.sessionId)}`}
      className="flex items-center gap-3 py-1.5 border-b border-border last:border-0 hover:bg-muted/40 transition-colors rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Open session ${agent.sessionId}`}
    >
      {/* Liveness dot — passive `aria-label` (no `role="status"`) avoids screen-reader
          spam on the 5s polling refetch; the label is read when the dot receives focus. */}
      <span
        aria-label={`Liveness: ${label}`}
        className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${livenessDotClass(agent.liveness)}`}
      />

      {/* Primary label: task title when available, branch/sessionId as fallback.
          The taskId secondary line gives the operator the canonical reference. */}
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium truncate block">{agent.taskTitle ?? agent.title}</span>
        {agent.taskId && <span className="text-xs text-muted-foreground">{agent.taskId}</span>}
      </div>

      {/* PR badge */}
      {agent.prNumber != null && (
        <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground flex-shrink-0">
          #{agent.prNumber}
          {agent.prStatus ? ` (${agent.prStatus})` : ""}
        </span>
      )}

      {/* Last activity */}
      <span className="text-xs text-muted-foreground flex-shrink-0 tabular-nums">
        {formatRelative(agent.lastActivityAt)}
      </span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Column header
// ---------------------------------------------------------------------------

function AgentsTableHeader() {
  return (
    <div className="flex items-center gap-3 py-1 mb-0.5 border-b border-border">
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex-shrink-0 w-20">
        Status
      </span>
      <span className="flex-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Session
      </span>
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex-shrink-0">
        PR
      </span>
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex-shrink-0 tabular-nums">
        Activity
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter / sort functions
// ---------------------------------------------------------------------------

function agentFilterFn(agent: AgentRow, filters: AgentFilters): boolean {
  if (filters.liveness !== "all" && agent.liveness !== filters.liveness) return false;
  if (filters.taskId.trim() !== "") {
    const needle = filters.taskId.trim().toLowerCase();
    if (!agent.taskId?.toLowerCase().includes(needle)) return false;
  }
  return true;
}

function agentSortFn(a: AgentRow, b: AgentRow, key: AgentSortKey, dir: SortDir): number {
  let cmp = 0;
  switch (key) {
    case "lastActivityAt": {
      const tA = new Date(a.lastActivityAt).getTime();
      const tB = new Date(b.lastActivityAt).getTime();
      cmp = tA - tB;
      break;
    }
    case "liveness":
      cmp = LIVENESS_ORDER[a.liveness] - LIVENESS_ORDER[b.liveness];
      break;
    case "sessionId":
      cmp = a.sessionId.localeCompare(b.sessionId);
      break;
  }
  // Stable tiebreaker — when many rows share the same primary key (common
  // for liveness sort when all sessions are stale), fall back to sessionId
  // so the sort produces a deterministic order and the dir toggle visibly
  // reverses the list rather than no-op'ing.
  if (cmp === 0 && key !== "sessionId") {
    cmp = a.sessionId.localeCompare(b.sessionId);
  }
  return dir === "asc" ? cmp : -cmp;
}

// ---------------------------------------------------------------------------
// Inner widget component (runs hooks after payload guard)
// ---------------------------------------------------------------------------

function AgentsInner({ agents }: { agents: AgentRow[] }) {
  const filterFn = useCallback(agentFilterFn, []);
  const sortFn = useCallback(agentSortFn, []);

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
  } = useListControls<AgentRow, AgentSortKey, AgentFilters>({
    items: agents,
    defaultPageSize: 20,
    defaultSortKey: "lastActivityAt",
    defaultSortDir: "desc",
    defaultFilters: DEFAULT_FILTERS,
    filterFn,
    sortFn,
    pageSizeOptions: [20, 50, 100],
    prefix: "ag",
  });

  return (
    <>
      {totalCount > 0 && (
        <AgentsControlBar
          sortKey={sortKey}
          sortDir={sortDir}
          filters={filters}
          pageSize={pageSize}
          pageSizeOptions={pageSizeOptions}
          hasActiveFilters={hasActiveFilters}
          onSort={setSort}
          onFilterLiveness={(v) => setFilter("liveness", v)}
          onFilterTaskId={(v) => setFilter("taskId", v)}
          onPageSize={setPageSize}
          onClearFilters={clearFilters}
        />
      )}

      {totalCount === 0 ? (
        <p className="text-sm text-muted-foreground">No agents</p>
      ) : filteredCount === 0 ? (
        <div className="py-6 text-center">
          <p className="text-sm text-muted-foreground">No agents match these filters</p>
          <Button variant="ghost" size="sm" onClick={clearFilters} className="mt-2 text-xs">
            Clear filters
          </Button>
        </div>
      ) : (
        <div>
          <AgentsTableHeader />
          {pageItems.map((agent) => (
            <AgentRowItem key={agent.sessionId} agent={agent} />
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

interface AgentsBodyProps {
  query: ReturnType<typeof useQuery<WidgetData, Error>>;
}

function AgentsBody({ query }: AgentsBodyProps) {
  // Error state (network failure, non-200, JSON parse error)
  if (query.isError) {
    return <p className="text-muted-foreground text-sm">Failed to load agents: {query.error.message}</p>;
  }
  // Loading state (no data yet, not an error)
  if (query.isLoading || !query.data) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }

  const data = query.data;

  // Degraded state (server-reported)
  if (data.state === "degraded") {
    return <p className="text-muted-foreground text-sm">{data.reason}</p>;
  }
  // Payload shape guard
  if (!isAgentsPayload(data.payload)) {
    return <p className="text-muted-foreground text-sm">Unexpected payload shape</p>;
  }

  return <AgentsInner agents={data.payload.agents} />;
}

// ---------------------------------------------------------------------------
// Main widget component — self-fetching via TanStack Query (mt#2373)
// ---------------------------------------------------------------------------

interface AgentsProps {
  /** Render-context variant; defaults to the home-grid card frame. */
  variant?: WidgetVariant;
  /** Title from the registry; defaults to the widget's canonical title for back-compat. */
  title?: string;
}

export function Agents({ variant = "card", title = "Agents" }: AgentsProps = {}) {
  const query = useQuery<WidgetData, Error>({
    queryKey: ["agents"],
    queryFn: fetchAgents,
    staleTime: 30_000,
    refetchInterval: 5_000,
  });

  return (
    <WidgetShell variant={variant} title={title}>
      <AgentsBody query={query} />
    </WidgetShell>
  );
}

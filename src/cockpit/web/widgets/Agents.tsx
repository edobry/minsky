/**
 * Agents widget frontend (mt#1145, mt#1924; unified run list per mt#2767)
 *
 * Displays the unified agent-run list — workspace sessions ("dispatched
 * agent"), standalone harness conversations ("principal conversation"), and
 * collapsed subagent groups — in a compact table. Self-fetching via
 * TanStack Query (5-second refetch interval).
 *
 * mt#1924: Added pagination, sorting, and filtering controls with URL param
 * persistence. Controls use prefix "ag" to namespace params.
 * mt#2767: Added the kind filter/badge, subagent expand/collapse, and the
 * live-tail pulse indicator (reusing `useActiveConversationSessions`, the
 * same mechanism the retired `/conversations` page used).
 */
import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "../components/ui/button";
import { WidgetShell, type WidgetVariant } from "../components/WidgetShell";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { useListControls, type SortDir } from "../lib/useListControls";
import { useActiveConversationSessions } from "../hooks/useActiveConversationSessions";
import { cn } from "../lib/utils";

/** Kind badge (mt#2767 Row model). Always "dispatched-agent" pre-mt#2767. */
type RunKind = "dispatched-agent" | "principal-conversation" | "subagent-group";

/** One nested subagent conversation, collapsed under a parent run's row. */
interface SubagentEntry {
  conversationId: string;
  label: string;
  cwd: string | null;
  startedAt: string | null;
}

// Inline mirror of the server AgentRow shape — frontend must stay self-contained
// (no imports of server code). Keep in sync with src/cockpit/widgets/agents.ts.
interface AgentRow {
  sessionId: string;
  kind: RunKind;
  title: string;
  liveness: "healthy" | "idle" | "stale" | "orphaned" | null;
  taskId: string | null;
  taskTitle: string | null;
  prNumber: number | null;
  prStatus: string | null;
  lastActivityAt: string;
  agentId: string | null;
  conversationId: string | null;
  cwd: string | null;
  subagents: SubagentEntry[];
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
// Kind badge
// ---------------------------------------------------------------------------

const KIND_BADGE_CONFIG: Record<RunKind, { label: string; className: string }> = {
  "dispatched-agent": { label: "Agent", className: "bg-primary/15 text-primary" },
  "principal-conversation": { label: "Conversation", className: "bg-sky-500/15 text-sky-500" },
  "subagent-group": { label: "Subagent", className: "bg-muted text-muted-foreground" },
};

function KindBadge({ kind }: { kind: RunKind }) {
  const cfg = KIND_BADGE_CONFIG[kind];
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${cfg.className}`}
    >
      {cfg.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sort / filter config
// ---------------------------------------------------------------------------

type AgentSortKey = "lastActivityAt" | "sessionId" | "liveness";

interface AgentFilters {
  liveness: "all" | "healthy" | "idle" | "stale" | "orphaned";
  taskId: string; // empty string = no filter
  kind: "all" | RunKind;
}

const DEFAULT_FILTERS: AgentFilters = {
  liveness: "all",
  taskId: "",
  kind: "all",
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
    case null:
      return "";
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
    case null:
      return "n/a";
  }
}

// Numeric order for sorting: healthy > idle > stale > orphaned; conversation-
// derived rows (no workspace liveness) sort after all of them.
const LIVENESS_ORDER: Record<string, number> = {
  healthy: 0,
  idle: 1,
  stale: 2,
  orphaned: 3,
};
const LIVENESS_ORDER_NULL = 4;

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
  onFilterKind: (value: AgentFilters["kind"]) => void;
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
  onFilterKind,
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

      {/* Kind filter (mt#2767) */}
      <span className="text-xs text-muted-foreground uppercase tracking-wide mr-1">Kind:</span>
      <select
        value={filters.kind}
        onChange={(e) => onFilterKind(e.target.value as AgentFilters["kind"])}
        className="text-xs bg-background border border-border rounded px-1.5 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        aria-label="Filter by kind"
      >
        <option value="all">All</option>
        <option value="dispatched-agent">Agent</option>
        <option value="principal-conversation">Conversation</option>
        <option value="subagent-group">Subagent</option>
      </select>

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
// Live-tail pulse indicator — mirrors the retired ConversationsPage's dot
// (mt#2749's useActiveConversationSessions), now surfaced on the unified list.
// ---------------------------------------------------------------------------

function LiveDot() {
  return (
    <span
      className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-emerald-400 animate-pulse"
      aria-label="live"
    />
  );
}

// ---------------------------------------------------------------------------
// Row-open target (mt#2767 kind-aware routing)
//
// - dispatched-agent: the workspace detail route (unchanged, mt#1919).
// - principal-conversation: the conversation detail route (mt#2398).
// - subagent-group: no single detail route (it's a synthetic collapsed
//   container, not a real entity) — the row toggles expand instead of
//   navigating; individual nested entries below link to their own
//   conversation.
// ---------------------------------------------------------------------------

function rowPath(agent: AgentRow): string | null {
  if (agent.kind === "dispatched-agent") return `/agents/${encodeURIComponent(agent.sessionId)}`;
  if (agent.kind === "principal-conversation") {
    return `/conversation/${encodeURIComponent(agent.sessionId)}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Nested subagent row (collapsed under its parent by default)
// ---------------------------------------------------------------------------

function SubagentRowItem({ entry, isLive }: { entry: SubagentEntry; isLive: boolean }) {
  return (
    <Link
      to={`/conversation/${encodeURIComponent(entry.conversationId)}`}
      className="flex items-center gap-2 py-1 pl-8 border-b border-border/60 last:border-0 hover:bg-accent/40 transition-colors rounded-sm"
      aria-label={`Open subagent conversation ${entry.label}`}
    >
      <KindBadge kind="subagent-group" />
      <span className="flex-1 min-w-0 flex items-center gap-1.5 text-sm truncate">
        {entry.label}
        {isLive && <LiveDot />}
      </span>
      <span className="text-xs text-muted-foreground flex-shrink-0 tabular-nums">
        {entry.startedAt ? formatRelative(entry.startedAt) : ""}
      </span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Agent row component
// ---------------------------------------------------------------------------

function AgentRowItem({
  agent,
  activeConversationIds,
}: {
  agent: AgentRow;
  activeConversationIds: Set<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const label = livenessLabel(agent.liveness);
  const path = rowPath(agent);
  const hasSubagents = agent.subagents.length > 0;
  const isLive = activeConversationIds.has(agent.conversationId ?? agent.sessionId);

  const body = (
    <>
      {/* Liveness dot — only meaningful for workspace rows; passive
          `aria-label` (no `role="status"`) avoids screen-reader spam on the
          5s polling refetch; the label is read when the dot receives focus. */}
      {agent.liveness != null ? (
        <span
          aria-label={`Liveness: ${label}`}
          className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${livenessDotClass(agent.liveness)}`}
        />
      ) : (
        <span className="inline-block h-2 w-2 flex-shrink-0" aria-hidden />
      )}

      <KindBadge kind={agent.kind} />

      {/* Primary label: task title when available, branch/sessionId as fallback.
          The taskId secondary line gives the operator the canonical reference. */}
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium truncate flex items-center gap-1.5">
          {agent.taskTitle ?? agent.title}
          {isLive && <LiveDot />}
        </span>
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
    </>
  );

  return (
    <div className="border-b border-border last:border-0">
      <div className="flex items-center gap-2">
        {/* Subagent expand/collapse toggle — always reserves a column so rows
            without children stay aligned with rows that have them. */}
        {hasSubagents ? (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-label={expanded ? "Collapse subagents" : "Expand subagents"}
            aria-expanded={expanded}
            className="flex-shrink-0 p-0.5 text-muted-foreground hover:text-foreground"
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span className="w-[18px] flex-shrink-0" aria-hidden />
        )}

        {path ? (
          <Link
            to={path}
            className={cn(
              "flex flex-1 min-w-0 items-center gap-3 py-1.5 hover:bg-accent/50 transition-colors rounded-sm"
            )}
            aria-label={`Open ${agent.kind === "dispatched-agent" ? "session" : "conversation"} ${agent.sessionId}`}
          >
            {body}
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="flex flex-1 min-w-0 items-center gap-3 py-1.5 text-left hover:bg-accent/30 transition-colors rounded-sm"
          >
            {body}
          </button>
        )}
      </div>

      {hasSubagents && expanded && (
        <div className="flex flex-col">
          {agent.subagents.map((entry) => (
            <SubagentRowItem
              key={entry.conversationId}
              entry={entry}
              isLive={activeConversationIds.has(entry.conversationId)}
            />
          ))}
        </div>
      )}
    </div>
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
  if (filters.kind !== "all" && agent.kind !== filters.kind) return false;
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
    case "liveness": {
      const orderA = a.liveness == null ? LIVENESS_ORDER_NULL : LIVENESS_ORDER[a.liveness];
      const orderB = b.liveness == null ? LIVENESS_ORDER_NULL : LIVENESS_ORDER[b.liveness];
      cmp = orderA - orderB;
      break;
    }
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
  const activeSessionsQuery = useActiveConversationSessions();
  const activeConversationIds = activeSessionsQuery.data ?? new Set<string>();

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
          onFilterKind={(v) => setFilter("kind", v)}
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
            <AgentRowItem
              key={agent.sessionId}
              agent={agent}
              activeConversationIds={activeConversationIds}
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

interface AgentsBodyProps {
  query: UseQueryResult<WidgetData, Error>;
}

function AgentsBody({ query }: AgentsBodyProps) {
  // Error state (network failure, non-200, JSON parse error)
  if (query.isError) {
    return (
      <p className="text-muted-foreground text-sm">Failed to load agents: {query.error.message}</p>
    );
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

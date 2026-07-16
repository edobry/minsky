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
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  ArrowUpRight,
  Terminal,
  AppWindow,
  Unlink,
  X,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { WidgetShell, type WidgetVariant } from "../components/WidgetShell";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { useListControls, type SortDir } from "../lib/useListControls";
import { useActiveConversationSessions } from "../hooks/useActiveConversationSessions";
import { useFocusAttachment } from "../hooks/useFocusAttachment";
import { basePathFor, pathForTab } from "./RunDetail";
import { cn } from "../lib/utils";

/** Kind badge (mt#2767 Row model; "driven-session" added by mt#2752). */
type RunKind = "dispatched-agent" | "principal-conversation" | "subagent-group" | "driven-session";

/**
 * Row attachment-state indicator (mt#2286) — mirrors the server-side
 * RowAttachState (src/cockpit/attachment-state.ts). Only ever populated for
 * `kind: "dispatched-agent"` rows; `null` for every other kind and for a
 * dispatched-agent row whose lookup degraded server-side.
 */
type RowAttachState = "attached-external" | "in-cockpit" | "detached";

/** One nested subagent conversation, collapsed under a parent run's row. */
interface SubagentEntry {
  conversationId: string;
  label: string;
  cwd: string | null;
  startedAt: string | null;
}

// Inline mirror of the server AgentRow shape — frontend must stay self-contained
// (no imports of server code). Keep in sync with src/cockpit/widgets/agents.ts.
// Exported for direct unit testing (Agents.routing.test.ts — resolveGoToAction).
export interface AgentRow {
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
  /** App-started driven-session binding (mt#2752) — the driven-vs-observed
   *  marker (SC4): non-null rows carry the input affordance. */
  driven: { sessionId: string; status: string } | null;
  /** Attachment-state indicator (mt#2286) — see the RowAttachState doc comment above. */
  attachState: RowAttachState | null;
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
  // mt#2752 — app-started driven sessions: the amber tint marks "you can type
  // here" (input affordance), vs the read-only observe rows above (SC4).
  "driven-session": { label: "Driven", className: "bg-amber-500/15 text-amber-500" },
};

/**
 * Small "Driven" chip attached to a WORKSPACE row whose session was launched
 * from the app (mt#2752) — links straight to the drive view. Distinct from
 * the kind badge: the row's kind stays "dispatched-agent" (it IS a workspace
 * row); this chip is the input affordance marker.
 */
function DrivenChip({ driven }: { driven: NonNullable<AgentRow["driven"]> }) {
  const active = driven.status === "running" || driven.status === "spawned";
  return (
    <Link
      to={`/driven/${encodeURIComponent(driven.sessionId)}`}
      onClick={(e) => e.stopPropagation()}
      className={`text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 transition-colors ${
        active
          ? "bg-amber-500/15 text-amber-500 hover:bg-amber-500/25"
          : "bg-muted text-muted-foreground hover:bg-accent"
      }`}
      aria-label={`Open driven session (${driven.status})`}
    >
      Driven{active ? "" : ` (${driven.status})`}
    </Link>
  );
}

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
        <option value="driven-session">Driven</option>
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
  // mt#2752 — a standalone driven-session row opens the drive view (the
  // input-capable surface); a workspace row with a driven session attached
  // keeps its workspace-detail route and gets a DrivenChip link instead.
  if (agent.kind === "driven-session") return `/driven/${encodeURIComponent(agent.sessionId)}`;
  return null;
}

// ---------------------------------------------------------------------------
// "Go to" action routing (mt#2286)
//
// Distinct from rowPath() above: rowPath() is the row's PRIMARY click target
// (a dispatched-agent row lands on the Overview tab, unchanged since
// mt#1919). This explicit per-row action routes by mt#2284 attachment state
// instead — an externally-attached session hits the focus endpoint (raises
// the operator's own terminal); an in-cockpit/no-terminal-context session (or
// any row kind with no attachment concept at all) navigates straight to the
// run's Conversation tab, since that's the point of "going to" a run rather
// than its Overview.
// ---------------------------------------------------------------------------

export type GoToAction =
  | { type: "focus"; sessionId: string }
  | { type: "navigate"; path: string }
  | { type: "disabled"; reason: string };

/** Exported for direct unit testing (Agents.routing.test.ts) — pure, no React/router dependency. */
export function resolveGoToAction(agent: AgentRow): GoToAction {
  if (agent.kind === "subagent-group") {
    // Synthetic collapsed container, not a real entity (mirrors rowPath()'s
    // treatment above) — nothing to go to until it's expanded.
    return { type: "disabled", reason: "Expand the row to open a subagent conversation" };
  }
  if (agent.kind === "driven-session") {
    // Inherently app-started ("in-cockpit" by construction) — no attachment
    // lookup applies.
    return { type: "navigate", path: `/driven/${encodeURIComponent(agent.sessionId)}` };
  }
  if (agent.kind === "principal-conversation") {
    return {
      type: "navigate",
      path: pathForTab(basePathFor("conversation", agent.sessionId), "conversation", "conversation"),
    };
  }

  // dispatched-agent — the only kind whose sessionId is a Minsky workspace
  // sessionId, the grain mt#2284's attachState is keyed on.
  switch (agent.attachState) {
    case "attached-external":
      return { type: "focus", sessionId: agent.sessionId };
    case "in-cockpit":
      return {
        type: "navigate",
        path: pathForTab(basePathFor("workspace", agent.sessionId), "workspace", "conversation"),
      };
    case "detached":
      return { type: "disabled", reason: "Nothing attached" };
    case null:
      // The lookup failed/degraded server-side this cycle (agents.ts logs a
      // warning) — behaviorally the same fail-closed "disabled" outcome as
      // "detached" (never guess whether there's something to focus), but the
      // operator-facing text says so honestly rather than falsely asserting
      // "nothing attached" when the real answer is "unknown" (mt#2286 R1
      // review finding — distinguishes a genuine detached state from a
      // degraded/unavailable read).
      return { type: "disabled", reason: "Attachment status unavailable" };
  }
}

const ATTACH_STATE_CONFIG: Record<
  RowAttachState,
  { icon: typeof Terminal; label: string; dim?: boolean }
> = {
  "attached-external": { icon: Terminal, label: "Attached — external terminal" },
  "in-cockpit": { icon: AppWindow, label: "Attached — in-cockpit" },
  detached: { icon: Unlink, label: "Nothing attached", dim: true },
};

/**
 * Small attachment-state indicator (mt#2286 SC) — distinct from the liveness
 * dot (activity-recency) and the live-tail pulse (active-conversation), so it
 * intentionally stays subtle (muted, icon-only, no color-coding) in an
 * already-dense row.
 */
function AttachStateIndicator({ state }: { state: AgentRow["attachState"] }) {
  if (state == null) return null;
  const cfg = ATTACH_STATE_CONFIG[state];
  const Icon = cfg.icon;
  return (
    <span
      title={cfg.label}
      aria-label={cfg.label}
      className={cn("flex-shrink-0", cfg.dim ? "text-muted-foreground/30" : "text-muted-foreground")}
    >
      <Icon className="h-3 w-3" />
    </span>
  );
}

/**
 * The explicit "go to" row action (mt#2286). Rendered as a SIBLING of the
 * row's main Link/button, not nested inside it — the row already nests a
 * DrivenChip <Link> inside the outer row <Link> (pre-existing), and adding a
 * second nested interactive element would compound that rather than fix it.
 */
function GoToActionButton({ agent }: { agent: AgentRow }) {
  const navigate = useNavigate();
  const focusMutation = useFocusAttachment();
  const action = resolveGoToAction(agent);

  if (action.type === "disabled") {
    return (
      <span
        title={action.reason}
        aria-label={`Go to (disabled — ${action.reason})`}
        className="flex-shrink-0 p-1 text-muted-foreground/30"
      >
        <ArrowUpRight className="h-3.5 w-3.5" />
      </span>
    );
  }

  const outcomeShowing = focusMutation.isSuccess || focusMutation.isError;

  // Auto-dismiss the transient outcome message (mt#2286 R1 review finding:
  // the prior version had no timeout/dismissal, so a stale outcome could
  // persist indefinitely across the widget's 5s polling refetches, and a
  // screen-reader user reading the live region had no way to move past it).
  // Runs `focusMutation.reset()`, which clears isSuccess/isError and
  // unmounts the message below — NOT a page/DOM focus change, which would be
  // the wrong move for a polite/assertive live-region announcement.
  useEffect(() => {
    if (!outcomeShowing) return;
    const timer = setTimeout(() => focusMutation.reset(), 8000);
    return () => clearTimeout(timer);
    // Deps intentionally exclude focusMutation: its identity is stable across
    // TanStack Query re-renders for a given hook instance, and re-running this
    // effect on every render (from including the whole mutation object) would
    // restart the timer on unrelated re-renders.
  }, [outcomeShowing]);

  function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (action.type === "navigate") {
      navigate(action.path);
      return;
    }
    focusMutation.mutate(action.sessionId);
  }

  function handleDismiss(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    focusMutation.reset();
  }

  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        onClick={handleClick}
        disabled={focusMutation.isPending}
        title={action.type === "focus" ? "Raise the attached terminal" : "Go to conversation"}
        aria-label="Go to"
        className="p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors disabled:opacity-50"
      >
        <ArrowUpRight className="h-3.5 w-3.5" />
      </button>
      {focusMutation.isSuccess && (
        <span
          role="status"
          className={cn(
            "absolute right-0 top-full z-10 mt-1 flex max-w-[16rem] items-start gap-1.5 whitespace-normal rounded border px-2 py-1 text-xs shadow-sm",
            focusMutation.data.success
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
              : "border-amber-500/40 bg-amber-500/10 text-amber-600"
          )}
        >
          <span className="flex-1">{focusMutation.data.message}</span>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dismiss"
            className="flex-shrink-0 opacity-70 hover:opacity-100"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      )}
      {focusMutation.isError && (
        <span
          role="alert"
          className="absolute right-0 top-full z-10 mt-1 flex max-w-[16rem] items-start gap-1.5 whitespace-normal rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive shadow-sm"
        >
          <span className="flex-1">{focusMutation.error.message}</span>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dismiss"
            className="flex-shrink-0 opacity-70 hover:opacity-100"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      )}
    </div>
  );
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

      {/* Attachment-state indicator (mt#2286) — distinct from the liveness
          dot and the live-tail pulse; null (hidden) for every kind other
          than dispatched-agent. */}
      <AttachStateIndicator state={agent.attachState} />

      {/* Primary label: task title when available, branch/sessionId as fallback.
          The taskId secondary line gives the operator the canonical reference. */}
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium truncate flex items-center gap-1.5">
          {agent.taskTitle ?? agent.title}
          {isLive && <LiveDot />}
        </span>
        {agent.taskId && <span className="text-xs text-muted-foreground">{agent.taskId}</span>}
      </div>

      {/* Driven chip — workspace rows with an app-started driven session
          (mt#2752). Standalone driven rows already navigate to /driven/:id
          via rowPath, so the chip is only for the annotated-workspace case. */}
      {agent.kind === "dispatched-agent" && agent.driven && <DrivenChip driven={agent.driven} />}

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
            aria-label={`Open ${
              agent.kind === "dispatched-agent"
                ? "session"
                : agent.kind === "driven-session"
                  ? "driven session"
                  : "conversation"
            } ${agent.sessionId}`}
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

        {/* Explicit "go to" action (mt#2286) — a SIBLING of the row Link
            above, not nested inside it (the row Link already nests a
            DrivenChip Link; this stays out of that). */}
        <GoToActionButton agent={agent} />
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

/**
 * AsksPage — full-page route for managing pending Asks (/asks).
 *
 * The Attention widget on the homepage is the digest ("you have N pending");
 * this page is the management surface listing pending asks. Row click
 * navigates to the URL-addressable detail at /ask/:id (mt#2410 — the prior
 * selectedAskId full-page swap is retired; AskPage owns detail + mutations).
 *
 * Self-fetching via TanStack Query against GET /api/asks.
 * Uses useListControls for pagination, filtering, and sorting.
 */
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../components/ui/button";
import { useListControls, type SortDir } from "../lib/useListControls";
import { cn } from "../lib/utils";
import {
  fetchAsks,
  formatRelative,
  formatDeadlineRemaining,
  kindStyle,
  KIND_PRIORITY,
  type AskItem,
  type AsksListResponse,
} from "../widgets/AskDetail";

// ---------------------------------------------------------------------------
// Filter / sort types
// ---------------------------------------------------------------------------

type SortKey = "age" | "priority" | "kind";

interface Filters {
  kind: string;
  requestor: string;
  cohort: string;
}

// ---------------------------------------------------------------------------
// Ask row (list item)
// ---------------------------------------------------------------------------

interface AskRowProps {
  ask: AskItem;
  onClick: () => void;
}

function AskRow({ ask, onClick }: AskRowProps) {
  const ks = kindStyle(ask.kind);
  const deadlineStr = formatDeadlineRemaining(ask.deadline);
  const isOverdue = deadlineStr === "overdue";

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-md",
        "border border-border bg-card hover:bg-muted/40 transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      )}
    >
      <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${ks.badge}`}>
        {ks.priority}
      </span>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{ask.title}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-muted-foreground">{ask.kind}</span>
          {ask.parentTaskId && (
            <span className="text-xs font-mono text-muted-foreground">{ask.parentTaskId}</span>
          )}
        </div>
      </div>

      <span className="text-xs text-muted-foreground font-mono flex-shrink-0 max-w-[120px] truncate hidden sm:block">
        {ask.requestor}
      </span>

      {deadlineStr && (
        <span
          className={`text-xs flex-shrink-0 tabular-nums ${isOverdue ? "text-destructive font-medium" : "text-muted-foreground"}`}
        >
          {deadlineStr}
        </span>
      )}

      <span className="text-xs text-muted-foreground flex-shrink-0 tabular-nums w-14 text-right">
        {formatRelative(ask.createdAt)}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export function AsksPage() {
  const navigate = useNavigate();

  const query = useQuery<AsksListResponse, Error>({
    queryKey: ["asks"],
    queryFn: fetchAsks,
    staleTime: 10_000,
    refetchInterval: 10_000,
  });

  const asks = query.data?.asks ?? [];

  const uniqueKinds = [...new Set(asks.map((a) => a.kind))].sort();
  const uniqueRequestors = [...new Set(asks.map((a) => a.requestor))].sort();
  const uniqueCohorts = [...new Set(asks.map((a) => a.windowKey ?? "(none)"))].sort();

  const controls = useListControls<AskItem, SortKey, Filters>({
    items: asks,
    defaultPageSize: 25,
    defaultSortKey: "age",
    defaultSortDir: "desc",
    defaultFilters: { kind: "all", requestor: "all", cohort: "all" },
    prefix: "asks",
    filterFn: (item, filters) => {
      if (filters.kind !== "all" && item.kind !== filters.kind) return false;
      if (filters.requestor !== "all" && item.requestor !== filters.requestor) return false;
      if (filters.cohort !== "all" && (item.windowKey ?? "(none)") !== filters.cohort) return false;
      return true;
    },
    sortFn: (a, b, key, dir) => {
      const mult = dir === "asc" ? 1 : -1;
      switch (key) {
        case "age": {
          const aTime = new Date(a.createdAt).getTime();
          const bTime = new Date(b.createdAt).getTime();
          return (aTime - bTime) * mult;
        }
        case "priority":
          return (KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]) * mult;
        case "kind":
          return a.kind.localeCompare(b.kind) * mult;
        default:
          return 0;
      }
    },
  });

  if (query.isError) {
    return (
      <div className="p-4 max-w-5xl mx-auto w-full">
        <p className="text-sm text-destructive">Failed to load asks: {query.error.message}</p>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-5xl mx-auto w-full space-y-3">
      {/* Header + controls */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-base font-semibold text-foreground">
          Asks
          {controls.filteredCount > 0 && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {controls.filteredCount} pending
            </span>
          )}
        </h1>

        <div className="flex items-center gap-2">
          <select
            value={controls.filters.kind}
            onChange={(e) => controls.setFilter("kind", e.target.value)}
            className="text-xs bg-muted border border-border rounded px-2 py-1 text-foreground"
            aria-label="Filter by kind"
          >
            <option value="all">All kinds</option>
            {uniqueKinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>

          <select
            value={controls.filters.requestor}
            onChange={(e) => controls.setFilter("requestor", e.target.value)}
            className="text-xs bg-muted border border-border rounded px-2 py-1 text-foreground"
            aria-label="Filter by requestor"
          >
            <option value="all">All requestors</option>
            {uniqueRequestors.map((r) => (
              <option key={r} value={r}>
                {r.length > 30 ? r.slice(0, 30) + "..." : r}
              </option>
            ))}
          </select>

          <select
            value={controls.filters.cohort}
            onChange={(e) => controls.setFilter("cohort", e.target.value)}
            className="text-xs bg-muted border border-border rounded px-2 py-1 text-foreground"
            aria-label="Filter by cohort"
          >
            <option value="all">All cohorts</option>
            {uniqueCohorts.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <select
            value={`${controls.sortKey}_${controls.sortDir}`}
            onChange={(e) => {
              const [newKey, newDir] = e.target.value.split("_") as [SortKey, SortDir];
              if (newKey === controls.sortKey && newDir === controls.sortDir) {
                return;
              }
              // setSort(newKey) on a different key always produces defaultSortDir ("desc")
              // setSort(sameKey) toggles direction
              const afterFirstCall: SortDir =
                newKey !== controls.sortKey ? "desc" : controls.sortDir === "asc" ? "desc" : "asc";
              controls.setSort(newKey);
              if (afterFirstCall !== newDir) {
                controls.setSort(newKey);
              }
            }}
            className="text-xs bg-muted border border-border rounded px-2 py-1 text-foreground"
            aria-label="Sort order"
          >
            <option value="age_desc">Newest first</option>
            <option value="age_asc">Oldest first</option>
            <option value="priority_asc">Priority (high first)</option>
            <option value="kind_asc">Kind (A-Z)</option>
          </select>

          {controls.hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={controls.clearFilters} className="text-xs">
              Clear
            </Button>
          )}
        </div>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground py-8 text-center">Loading...</p>
      ) : controls.filteredCount === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm font-medium text-foreground">No pending asks</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {controls.hasActiveFilters
              ? "No asks match your current filters."
              : "All clear — nothing needs your attention."}
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {controls.pageItems.map((ask) => (
            <AskRow
              key={ask.id}
              ask={ask}
              onClick={() => navigate(`/ask/${encodeURIComponent(ask.id)}`)}
            />
          ))}
        </div>
      )}

      {controls.pageCount > 1 && (
        <div className="flex items-center justify-between pt-2">
          <span className="text-xs text-muted-foreground">
            Page {controls.page} of {controls.pageCount}
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={controls.page <= 1}
              onClick={() => controls.setPage(controls.page - 1)}
            >
              Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={controls.page >= controls.pageCount}
              onClick={() => controls.setPage(controls.page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * ChangesetsPage — list route for active PRs across sessions (/changesets).
 *
 * Self-fetching via TanStack Query against GET /api/changesets.
 * Filter by review state and age (last 24h / 7d / all); sort by age
 * (newest-first default) or attention-required. Row click navigates to
 * /changeset/:prNumber (the in-cockpit detail route from mt#2535).
 *
 * CI-state filter (mt#2561): deferred — even though mt#2076/mt#2435 shipped,
 * `SessionRecord.pullRequest` / `SessionPrRef` (src/cockpit/session-detail.ts)
 * still carry no CI/check-run field, so there is no data path to filter on.
 * The CI column continues to degrade to "—" (see Changesets.tsx) until a task
 * wires CI/check-run state onto the session-record source.
 * Uses useListControls for filter/sort/pagination, mirroring AsksPage pattern.
 */
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../components/ui/button";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { useListControls, type SortDir } from "../lib/useListControls";
import { changesetRecencyTime } from "../lib/format";
import { useProject } from "../lib/project-context";
import {
  Changesets,
  type ChangesetItem,
  type ChangesetsListResponse,
} from "../widgets/Changesets";

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

async function fetchChangesets(queryParam?: { project: string }): Promise<ChangesetsListResponse> {
  const qs = queryParam ? `?project=${encodeURIComponent(queryParam.project)}` : "";
  const res = await fetch(`/api/changesets${qs}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to load changesets: ${res.status}${body ? ` — ${body}` : ""}`);
  }
  return res.json() as Promise<ChangesetsListResponse>;
}

// ---------------------------------------------------------------------------
// Filter / sort types
// ---------------------------------------------------------------------------

type SortKey = "age" | "attention";

/** Age-filter bucket → max age in ms (null = no upper bound / "all"). */
const AGE_FILTER_MS: Record<string, number | null> = {
  all: null,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

interface Filters {
  reviewState: string;
  age: string;
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function ChangesetsPage() {
  const navigate = useNavigate();
  const { selectedSlug, queryParam } = useProject();

  const query = useQuery<ChangesetsListResponse, Error>({
    // mt#2418: selectedSlug in the key so switching projects invalidates
    // the cache and refetches immediately rather than waiting out staleTime.
    queryKey: ["changesets", selectedSlug],
    queryFn: () => fetchChangesets(queryParam),
    staleTime: 15_000,
    refetchInterval: 15_000,
  });

  const changesets = query.data?.changesets ?? [];

  const uniqueReviewStates = [
    ...new Set(
      changesets.map((c) => (c.pr.approved == null ? "unknown" : c.pr.approved ? "approved" : "pending"))
    ),
  ].sort();

  const controls = useListControls<ChangesetItem, SortKey, Filters>({
    items: changesets,
    defaultPageSize: 30,
    defaultSortKey: "age",
    defaultSortDir: "desc",
    defaultFilters: { reviewState: "all", age: "all" },
    prefix: "changesets",
    filterFn: (item, filters) => {
      if (filters.reviewState !== "all") {
        const state =
          item.pr.approved == null
            ? "unknown"
            : item.pr.approved
              ? "approved"
              : "pending";
        if (state !== filters.reviewState) return false;
      }
      // Age filter: narrows to changesets active within the bucket's window,
      // using the same recency proxy (changesetRecencyTime) the sort uses —
      // lastActivityAt ?? createdAt (mt#1920 R1/R2, mt#2561).
      const maxAgeMs = AGE_FILTER_MS[filters.age];
      if (maxAgeMs != null) {
        const recencyMs = changesetRecencyTime(item.session);
        if (recencyMs === 0 || Date.now() - recencyMs > maxAgeMs) return false;
      }
      return true;
    },
    sortFn: (a, b, key, dir) => {
      const mult = dir === "asc" ? 1 : -1;
      switch (key) {
        case "age": {
          // Recency proxy (lastActivityAt ?? createdAt), NOT createdAt alone —
          // must match the server sort (compareChangesetsByRecency) and the row
          // "Age" column so the client default order doesn't override the
          // server's newest-by-activity order. mt#1920 R2.
          return (changesetRecencyTime(a.session) - changesetRecencyTime(b.session)) * mult;
        }
        case "attention": {
          // Attention-required order: pending review (not approved, not null) first.
          // Among ties, most-recently-active first (same recency proxy as "age").
          const aNeeds = a.pr.approved === false ? 0 : 1;
          const bNeeds = b.pr.approved === false ? 0 : 1;
          if (aNeeds !== bNeeds) return (aNeeds - bNeeds) * mult;
          return (changesetRecencyTime(b.session) - changesetRecencyTime(a.session)) * mult;
        }
        default:
          return 0;
      }
    },
  });

  function handleRowClick(item: ChangesetItem) {
    if (item.pr.number != null) {
      navigate(`/changeset/${encodeURIComponent(String(item.pr.number))}`);
    }
  }

  if (query.isError) {
    return (
      <div className="p-4 max-w-5xl mx-auto w-full">
        <ErrorState prefix="Failed to load changesets" error={query.error} />
      </div>
    );
  }

  return (
    <div className="p-4 max-w-5xl mx-auto w-full space-y-3">
      {/* Header + controls */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-base font-semibold text-foreground">
          Changesets
          {controls.filteredCount > 0 && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {controls.filteredCount} active
            </span>
          )}
        </h1>

        <div className="flex items-center gap-2">
          <select
            value={controls.filters.reviewState}
            onChange={(e) => controls.setFilter("reviewState", e.target.value)}
            className="text-xs bg-muted border border-border rounded px-2 py-1 text-foreground"
            aria-label="Filter by review state"
          >
            <option value="all">All review states</option>
            {uniqueReviewStates.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>

          <select
            value={controls.filters.age}
            onChange={(e) => controls.setFilter("age", e.target.value)}
            className="text-xs bg-muted border border-border rounded px-2 py-1 text-foreground"
            aria-label="Filter by age"
          >
            <option value="all">Any age</option>
            <option value="24h">Active in last 24h</option>
            <option value="7d">Active in last 7d</option>
          </select>

          <select
            value={`${controls.sortKey}_${controls.sortDir}`}
            onChange={(e) => {
              const [newKey, newDir] = e.target.value.split("_") as [SortKey, SortDir];
              if (newKey === controls.sortKey && newDir === controls.sortDir) return;
              const afterFirstCall: SortDir =
                newKey !== controls.sortKey
                  ? "desc"
                  : controls.sortDir === "asc"
                    ? "desc"
                    : "asc";
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
            <option value="attention_asc">Attention required</option>
          </select>

          {controls.hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={controls.clearFilters} className="text-xs">
              Clear
            </Button>
          )}
        </div>
      </div>

      {query.isLoading ? (
        <LoadingState message="Loading changesets…" variant="page" />
      ) : (
        <Changesets items={controls.pageItems} onRowClick={handleRowClick} />
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

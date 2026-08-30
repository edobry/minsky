/**
 * MemoriesFamilies — the families view (mt#4763).
 *
 * One row per `family:<slug>` tag: member count, first/most-recent member
 * date, and the linked structural-fix task(s) found by matching the same
 * tag on tasks (`memories-families.ts` does the join). Sortable by member
 * count and by recency client-side — the payload is one row per family
 * (measured 38 at spec-authoring time), nowhere near large enough to need
 * server-side paging the way the main list does.
 *
 * Rendered by `MemoriesPage.tsx` in place of `<MemoriesList>` + the facet
 * rail when the `mem_view=families` cohort is selected — a genuinely
 * different VIEW, not a filter over the same table (mt#4763 spec's
 * `## Scope`: "a new families widget/view").
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { WidgetShell, type WidgetVariant } from "../components/WidgetShell";
import { EntityRef } from "../components/EntityRef";
import { SortIndicator } from "../components/SortIndicator";
import { useProject } from "../lib/project-context";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// Payload shape (mirrors `memories-families.ts`'s `FamilyRow` — frontend
// code can't import `src/cockpit/widgets/*`, server-only; same convention
// `MemoriesList.tsx` already documents for its own payload shapes).
// ---------------------------------------------------------------------------

interface FamilyRow {
  slug: string;
  tag: string;
  memberCount: number;
  firstMemberAt: string;
  mostRecentMemberAt: string;
  structuralFixTasks: string[];
}

interface MemoriesFamiliesPayload {
  families: FamilyRow[];
}

type SortKey = "memberCount" | "recency";
type SortDir = "asc" | "desc";

function relativeTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const diffMs = Date.now() - d.getTime();
  const diffDay = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDay < 1) return "today";
  if (diffDay === 1) return "1d ago";
  if (diffDay < 30) return `${diffDay}d ago`;
  return `${Math.floor(diffDay / 30)}mo ago`;
}

function sortFamilies(rows: FamilyRow[], key: SortKey, dir: SortDir): FamilyRow[] {
  const sorted = [...rows].sort((a, b) => {
    const cmp =
      key === "memberCount"
        ? a.memberCount - b.memberCount
        : new Date(a.mostRecentMemberAt).getTime() - new Date(b.mostRecentMemberAt).getTime();
    return dir === "asc" ? cmp : -cmp;
  });
  return sorted;
}

function FamiliesTable({ families }: { families: FamilyRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("memberCount");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const sorted = useMemo(
    () => sortFamilies(families, sortKey, sortDir),
    [families, sortKey, sortDir]
  );

  function onSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  if (families.length === 0) {
    return (
      <p className="text-xs text-muted-foreground text-center py-8">
        No `family:*` tags found in the current scope.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto -mx-6 px-6">
      <div className="flex items-center gap-3 py-1.5 mb-0.5 border-b border-border text-eyebrow font-mono uppercase text-muted-foreground">
        <span className="flex-1 min-w-0">Family</span>
        <button
          onClick={() => onSort("memberCount")}
          className="w-20 flex-shrink-0 text-right hover:text-foreground transition-colors"
        >
          Members
          <SortIndicator active={sortKey === "memberCount"} dir={sortDir} />
        </button>
        <span className="w-24 flex-shrink-0 text-right hidden md:block">First</span>
        <button
          onClick={() => onSort("recency")}
          className="w-24 flex-shrink-0 text-right hover:text-foreground transition-colors"
        >
          Recent
          <SortIndicator active={sortKey === "recency"} dir={sortDir} />
        </button>
        <span className="w-40 flex-shrink-0 text-right">Structural fix</span>
      </div>
      {sorted.map((f) => (
        <div
          key={f.tag}
          data-testid="family-row"
          className="flex items-center gap-3 py-1.5 border-b border-border/50 last:border-0"
        >
          <a
            href={`/memories?mem_f_tags=${encodeURIComponent(f.tag)}`}
            title={f.tag}
            className="flex-1 min-w-0 truncate text-body text-primary hover:underline"
          >
            {f.slug}
          </a>
          <span className="w-20 flex-shrink-0 text-right tabular-nums text-small">
            {f.memberCount}
          </span>
          <span
            className="w-24 flex-shrink-0 text-right tabular-nums text-small text-muted-foreground hidden md:block"
            title={f.firstMemberAt}
          >
            {relativeTime(f.firstMemberAt)}
          </span>
          <span
            className="w-24 flex-shrink-0 text-right tabular-nums text-small text-muted-foreground"
            title={f.mostRecentMemberAt}
          >
            {relativeTime(f.mostRecentMemberAt)}
          </span>
          <div className="w-40 flex-shrink-0 flex flex-wrap justify-end gap-1">
            {f.structuralFixTasks.length === 0 ? (
              <span className="text-small text-muted-foreground">—</span>
            ) : (
              f.structuralFixTasks.map((taskId) => (
                <EntityRef key={taskId} type="task" id={taskId} className="text-[10px]" />
              ))
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function MemoriesFamiliesInner() {
  // PR #3500 R1 BLOCKING: this used to fetch with an empty params object,
  // which relied on `apiFetch`'s implicit default-append (mt#4730) — but
  // the queryKey below carried no project dependency, so a project switch
  // mid-session never invalidated the cache and this view kept showing
  // whatever scope it FIRST mounted with (unscoped, if that was "All
  // projects"), silently diverging from the list beside it. Threading
  // `projectParam` explicitly — same as `FacetsRail`/`MemoriesList` — fixes
  // both halves: the fetch is scoped AND the cache key reacts to a switch.
  const { queryParam: projectParam } = useProject();
  const params: Record<string, string> = {};
  if (projectParam) params.project = projectParam.project;

  const query = useQuery<WidgetData, Error>({
    queryKey: ["widget", "memories-families", projectParam?.project ?? ""],
    queryFn: () => fetchWidgetData("memories-families", params),
    staleTime: 30_000,
  });

  if (query.isLoading || !query.data) {
    return <p className="text-xs text-muted-foreground py-8 text-center">Loading…</p>;
  }
  if (query.isError || query.data.state === "degraded") {
    const reason = query.isError ? query.error.message : (query.data as { reason: string }).reason;
    return <p className="text-xs text-muted-foreground">{reason}</p>;
  }

  const payload = query.data.payload as MemoriesFamiliesPayload;
  return <FamiliesTable families={payload.families} />;
}

export function MemoriesFamilies({ variant = "card" }: { variant?: WidgetVariant }) {
  return (
    <WidgetShell variant={variant} title="Failure Families">
      <MemoriesFamiliesInner />
    </WidgetShell>
  );
}

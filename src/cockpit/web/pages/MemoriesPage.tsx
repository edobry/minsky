import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MemoriesHealth } from "../widgets/MemoriesHealth";
import { MemoriesCuration } from "../widgets/MemoriesCuration";
import { MemoriesList } from "../widgets/MemoriesList";
import { MemoriesFamilies } from "../widgets/MemoriesFamilies";
import { MemoriesDuplicates } from "../widgets/MemoriesDuplicates";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { useProject } from "../lib/project-context";
import { cn } from "../lib/utils";
import { PROVENANCE_TAG_NAMESPACES } from "@minsky/shared/memory-tag-namespaces";
import {
  VIEW_PARAM,
  memFilterKey,
  readMemFilter,
  readView,
  readExcludeSuperseded,
  parseTagList,
  writeMemoriesUrl,
  useReactiveSearch,
} from "../lib/memories-url";

/**
 * mt#4762: the standalone `<MemorySearch>` card (a third of the viewport for
 * one sentence of placeholder, and not composable with the table below it —
 * see the mt#4762 spec's `## Summary`) is retired FROM THIS PAGE. Search now
 * lives inside `MemoriesList`'s own toolbar — typing narrows the table in
 * place instead of rendering a separate result list. `MemorySearch.tsx`
 * itself is untouched: it stays registered as a standalone widget
 * (`src/cockpit/widget-registry.ts`) for any other render context that wants
 * the compact card form.
 *
 * mt#4763 adds a facet rail + cohort switcher above `<MemoriesList>`, plus a
 * families view that replaces it entirely when selected. Both need to write
 * to the SAME `mem_f_*` URL params `MemoriesList`'s own `useListControls`
 * instance reads — see the "Cross-component URL sync" section below for why
 * a plain `history.replaceState` isn't sufficient on its own.
 */

// ---------------------------------------------------------------------------
// Cross-component URL sync (mt#4763)
//
// `MemoriesList` owns its filter state via `useListControls`, which reads
// `window.location.search` through a PRIVATE React state that only updates
// on its own actions or on a genuine `popstate` event. This page's facet
// rail and cohort switcher are SIBLINGS of `MemoriesList`, not children, so
// they cannot call into that private state directly — but they DO need to
// drive the exact same `mem_f_tags` / `mem_f_type` / etc. URL params so a
// facet click and a row click converge on one filtered view (mt#4763 AT4/
// AT6). The fix: write the URL exactly the way `useListControls` itself
// does (`history.replaceState`, same `mem_f_<key>` key shape), then
// manually dispatch a `popstate` event — which `replaceState` never fires
// on its own, but which `MemoriesList`'s existing listener (added for
// browser back/forward) treats identically to a real one. No changes to
// `useListControls.ts` or `MemoriesList.tsx`'s hook usage were needed.
// ---------------------------------------------------------------------------

// These moved to `../lib/memories-url` (mt#4767) so the curation worklists
// can write the same URL space without importing from the page that renders
// them. Re-exported here because this module was their public home and both
// this page's tests and future callers resolve them from it.
export {
  memFilterKey,
  readMemFilter,
  readView,
  parseTagList,
  readExcludeSuperseded,
} from "../lib/memories-url";

// ---------------------------------------------------------------------------
// Cohort switcher (mt#4763 success criterion)
//
// Each preset is a URL-expressed filter, not a special code path — every
// cohort but "Families" is DERIVED from the same `mem_f_*` params
// `MemoriesList` already reads, so clicking a cohort is indistinguishable
// from a user setting those filters by hand. "Families" is the one
// exception: it swaps the rendered VIEW entirely (a `mem_view=families`
// page-level toggle), because a families rollup is not a filtered slice of
// the same table — see `MemoriesFamilies.tsx`.
// ---------------------------------------------------------------------------

type CohortId = "all" | "recent" | "handoffs" | "families" | "retrospectives" | "bridge" | "cold";

interface CohortDef {
  id: CohortId;
  label: string;
  apply: () => void;
  isActive: (search: string) => boolean;
}

/** Matches `memories-stats.ts`'s own `recentCount` window — the one other place "recent" is defined in this system. */
const RECENT_WINDOW_DAYS = 7;

// mt#4767: the curation worklist keys join this list. A cohort click must
// clear them, or a worklist left active from a previous click silently ANDs
// with the new cohort — "Handoffs" would quietly mean "untagged handoffs" and
// the count would disagree with the chip.
const FILTER_COHORT_KEYS = [
  "tags",
  "since",
  "unreadOrCold",
  // Legacy alias for the key above (mt#4799) — cleared for the same reason.
  "stale",
  "cold",
  "coldDays",
  "untagged",
  "neverAccessed",
  "onlySuperseded",
  // PR #3508 R1: the cohort chips have the same search-mode defect the
  // reviewer found on the worklists. `MemoriesList` switches to search mode
  // whenever `q` is non-empty, and search mode queries `memories-search`,
  // which takes no `mem_f_*` filters — so clicking "Handoffs" with a search
  // active highlighted the chip while the table showed search results the tag
  // filter never touched. This predates mt#4767 (mt#4763 shipped the chips);
  // fixed here rather than filed, because it is the same class as the finding
  // and one line from it.
  "q",
] as const;

function clearFilterCohortKeys(): Record<string, null> {
  const updates: Record<string, null> = { [VIEW_PARAM]: null };
  for (const key of FILTER_COHORT_KEYS) updates[memFilterKey(key)] = null;
  return updates;
}

/**
 * True when the ordinary filtered TABLE is what the page is rendering.
 *
 * Two things displace it, and every cohort's active-check has to account for
 * both (PR #3508 R1): a page-level view (`mem_view=families`/`duplicates`)
 * replaces the table outright, and a non-empty search query switches
 * `MemoriesList` into search mode, where it queries `memories-search` and
 * ignores every `mem_f_*` filter. A chip highlighted in either state asserts a
 * cohort the table is not showing.
 */
function isPlainView(search: string): boolean {
  return readView(search) === "" && readMemFilter(search, "q").trim() === "";
}

/**
 * True when any last-accessed / curation narrowing filter is set (mt#4767).
 *
 * The "All" and "Recent" cohorts use this to decide they are NOT active. It
 * has to cover every worklist key, not just the union filter: before mt#4767
 * the check was a bare `readMemFilter(s, "stale") !== "true"`, so clicking a
 * worklist would leave "All" rendering as the selected chip while the table
 * showed a narrowed list — the chip row asserting something the table
 * contradicts. (`stale` was renamed to `unreadOrCold` by mt#4799; the old key
 * is still read here so a bookmarked link keeps de-selecting "All".)
 */
function hasNarrowingFilter(search: string): boolean {
  return (
    readMemFilter(search, "unreadOrCold") === "true" ||
    readMemFilter(search, "stale") === "true" ||
    readMemFilter(search, "cold") === "true" ||
    readMemFilter(search, "untagged") === "true" ||
    readMemFilter(search, "neverAccessed") === "true" ||
    readMemFilter(search, "onlySuperseded") === "true"
  );
}

export const COHORT_DEFS: CohortDef[] = [
  {
    id: "all",
    label: "All",
    apply: () => writeMemoriesUrl(clearFilterCohortKeys()),
    isActive: (s) =>
      isPlainView(s) &&
      readMemFilter(s, "tags") === "" &&
      readMemFilter(s, "since") === "" &&
      !hasNarrowingFilter(s),
  },
  {
    id: "recent",
    label: "Recent",
    apply: () => {
      const since = new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
      writeMemoriesUrl({ ...clearFilterCohortKeys(), [memFilterKey("since")]: since });
    },
    isActive: (s) =>
      isPlainView(s) &&
      readMemFilter(s, "since") !== "" &&
      readMemFilter(s, "tags") === "" &&
      !hasNarrowingFilter(s),
  },
  {
    id: "handoffs",
    label: "Handoffs",
    apply: () => writeMemoriesUrl({ ...clearFilterCohortKeys(), [memFilterKey("tags")]: "handoff" }),
    isActive: (s) => isPlainView(s) && readMemFilter(s, "tags") === "handoff",
  },
  {
    id: "families",
    label: "Families",
    apply: () => writeMemoriesUrl({ [VIEW_PARAM]: "families" }),
    isActive: (s) => readView(s) === "families",
  },
  {
    id: "retrospectives",
    label: "Retrospectives",
    apply: () =>
      writeMemoriesUrl({ ...clearFilterCohortKeys(), [memFilterKey("tags")]: "retrospective" }),
    isActive: (s) => isPlainView(s) && readMemFilter(s, "tags") === "retrospective",
  },
  {
    id: "bridge",
    label: "Bridge memories",
    apply: () =>
      writeMemoriesUrl({ ...clearFilterCohortKeys(), [memFilterKey("tags")]: "bridge-memory" }),
    isActive: (s) => isPlainView(s) && readMemFilter(s, "tags") === "bridge-memory",
  },
  {
    // mt#4767: was `id: "stale", label: "Stale"`, filtering on `mem_f_stale`.
    // Both halves were wrong and in different ways.
    //
    // The LABEL collided: `staleness.ts` emits "⚠️ POSSIBLY OBSOLETE" for a
    // memory whose TRACKING TASK shipped — an unrelated property — so the
    // page showed one word for two meanings.
    //
    // The FILTER was worse: the union filter is `last_accessed_at IS NULL OR
    // older than N`, so a chip meaning "read a while ago" was actually serving
    // never-read records too. Measured 2026-08-31, that is 251 of the 252
    // rows it returned. It now filters on `cold`, which requires
    // `last_accessed_at IS NOT NULL` and says what it means.
    //
    // A legacy `?mem_f_stale=true` link still filters and still lights this
    // chip, so shared URLs keep working while new clicks write the honest
    // param. mt#4799 renamed the domain field `stale` → `unreadOrCold` and
    // kept `stale` as a read-only alias at every layer, so those links behave
    // exactly as they did — including the wrinkle that they run the UNION
    // query while lighting a chip labelled "Cold". That mismatch is inherited
    // from mt#4767's decision to keep the links working, not introduced here.
    id: "cold",
    label: "Cold",
    apply: () => writeMemoriesUrl({ ...clearFilterCohortKeys(), [memFilterKey("cold")]: "true" }),
    isActive: (s) =>
      isPlainView(s) &&
      (readMemFilter(s, "cold") === "true" ||
        readMemFilter(s, "unreadOrCold") === "true" ||
        readMemFilter(s, "stale") === "true"),
  },
];

function CohortSwitcher({ search }: { search: string }) {
  return (
    <div className="flex flex-wrap gap-1 py-1" role="tablist" aria-label="Memory cohort">
      {COHORT_DEFS.map((def) => {
        const active = def.isActive(search);
        return (
          <button
            key={def.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={def.apply}
            className={cn(
              "px-2 py-1 rounded text-xs font-medium transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/70"
            )}
          >
            {def.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Facet rail (mt#4763 success criterion)
//
// Fetches `memories-facets`, scoped to the SAME type/scope/excludeSuperseded
// filters and project scope the table below is showing (AT3: counts must
// narrow, not stay global). Clicking a tag TOGGLES its membership in
// `mem_f_tags` — multi-select, AND semantics (AT4) — as opposed to a row's
// or the detail page's single-tag REPLACE (AT6). Provenance namespaces
// (`imported-from`, `content-hash`) are collapsed behind a "Show" toggle by
// default; every other namespace (`family`, `theme`, `tracking`, …) renders
// expanded.
// ---------------------------------------------------------------------------

interface TagFacet {
  tag: string;
  count: number;
}

interface NamespaceFacetGroup {
  namespace: string;
  tags: TagFacet[];
  totalCount: number;
}

interface MemoriesFacetsPayload {
  flat: TagFacet[];
  namespaces: NamespaceFacetGroup[];
}

/**
 * Single-sourced with the backend `memories-facets` widget via
 * `@minsky/shared/memory-tag-namespaces` (PR #3500 R1 non-blocking fix) —
 * this used to be an independent local copy of the same list, which is
 * exactly the drift risk the reviewer flagged.
 */
const PROVENANCE_NAMESPACES = new Set<string>(PROVENANCE_TAG_NAMESPACES);

/** How many non-namespaced tags the rail shows before the rest fold into the corpus's own long tail — the full set is still in `payload.flat`, this only bounds the RENDER. */
const FLAT_TAG_DISPLAY_LIMIT = 20;

export function buildFacetsParams(
  search: string,
  projectParam: { project: string } | undefined
): Record<string, string> {
  const params: Record<string, string> = {};
  const type = readMemFilter(search, "type");
  const scope = readMemFilter(search, "scope");
  if (type) params.type = type;
  if (scope) params.scope = scope;
  if (readExcludeSuperseded(search) === "true") params.excludeSuperseded = "true";
  if (projectParam) params.project = projectParam.project;
  return params;
}

function FacetChip({
  tag,
  count,
  label,
  active,
  onClick,
}: {
  tag: string;
  count: number;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={tag}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-primary/20 hover:text-primary"
      )}
    >
      {label}
      <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );
}

function FacetsRail({
  search,
  projectParam,
}: {
  search: string;
  projectParam: { project: string } | undefined;
}) {
  const [showProvenance, setShowProvenance] = useState(false);
  const params = buildFacetsParams(search, projectParam);
  const activeTags = parseTagList(readMemFilter(search, "tags"));

  const query = useQuery<WidgetData, Error>({
    queryKey: [
      "widget",
      "memories-facets",
      params.type ?? "",
      params.scope ?? "",
      params.excludeSuperseded ?? "",
      projectParam?.project ?? "",
    ],
    queryFn: () => fetchWidgetData("memories-facets", params),
    staleTime: 20_000,
  });

  function toggleTag(tag: string) {
    const next = activeTags.includes(tag)
      ? activeTags.filter((t) => t !== tag)
      : [...activeTags, tag];
    writeMemoriesUrl({ [memFilterKey("tags")]: next.length > 0 ? next.join(",") : null });
  }

  // Fail-open: the rail is a discovery convenience, never load-bearing —
  // a degraded facets widget must not take the whole page down.
  if (query.isLoading || !query.data || query.isError || query.data.state === "degraded") {
    return null;
  }

  const payload = query.data.payload as MemoriesFacetsPayload;
  const flatVisible = payload.flat.slice(0, FLAT_TAG_DISPLAY_LIMIT);
  const semanticNamespaces = payload.namespaces.filter((ns) => !PROVENANCE_NAMESPACES.has(ns.namespace));
  const provenanceNamespaces = payload.namespaces.filter((ns) => PROVENANCE_NAMESPACES.has(ns.namespace));

  if (flatVisible.length === 0 && payload.namespaces.length === 0) return null;

  // Bounded-height, internally-scrollable band (PR #3500 R2 — Eugene's own
  // screenshot finding, not a reviewer BLOCKING/NON-BLOCKING item): with
  // enough distinct tags (measured: ~70 chips across 8 rows on the live
  // corpus) an unbounded band pushed the table — the page's PRIMARY
  // surface — below the fold on a 1440x1000 viewport (first row ~730px
  // down, only 3 rows visible). Considered three shapes on the merits:
  //   1. A literal side rail (this codebase's own idiom for "rail" —
  //      `components/Rail.tsx` is a persistent vertical column) costs the
  //      table zero vertical space, but ~70 chips wrapped into a ~240px
  //      column would still need its own height bound to avoid an
  //      absurdly tall column — so it doesn't eliminate the need for a
  //      scroll bound, it only relocates it — and it requires restructuring
  //      this page into a two-column grid, a materially bigger change.
  //   2. A collapsed-by-default band (only the top N, expand for the rest)
  //      partially defeats mt#4763's own premise — the discovery problem —
  //      by hiding the FAMILY/THEME/TRACKING grouping this page exists to
  //      surface, exactly the content Eugene called out as "the content
  //      itself is right."
  //   3. A bounded-height scrollable band (chosen): keeps every namespace
  //      group visible without an extra click, costs a small fixed amount
  //      of vertical space regardless of corpus size, and is a one-line
  //      change (`max-h-* overflow-y-auto`) with no page-layout risk.
  // `max-h-32` (128px) fits roughly 5 chip rows before scrolling — enough
  // to show the flat top-N tags plus a namespace group or two at a glance,
  // while leaving the table's own header comfortably above the fold.
  return (
    <div className="border-b border-border py-2" data-testid="facets-rail">
      <div className="max-h-32 overflow-y-auto space-y-1.5 pr-1">
      {flatVisible.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {flatVisible.map((f) => (
            <FacetChip
              key={f.tag}
              tag={f.tag}
              count={f.count}
              label={f.tag}
              active={activeTags.includes(f.tag)}
              onClick={() => toggleTag(f.tag)}
            />
          ))}
        </div>
      )}
      {semanticNamespaces.map((ns) => (
        <div key={ns.namespace} className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-0.5">
            {ns.namespace}
          </span>
          {ns.tags.map((f) => (
            <FacetChip
              key={f.tag}
              tag={f.tag}
              count={f.count}
              label={f.tag.slice(ns.namespace.length + 1)}
              active={activeTags.includes(f.tag)}
              onClick={() => toggleTag(f.tag)}
            />
          ))}
        </div>
      ))}
      {provenanceNamespaces.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowProvenance((v) => !v)}
            className="text-[10px] text-muted-foreground underline underline-offset-2"
          >
            {showProvenance ? "Hide" : "Show"} provenance tags (
            {provenanceNamespaces.reduce((sum, ns) => sum + ns.totalCount, 0)})
          </button>
          {showProvenance &&
            provenanceNamespaces.map((ns) => (
              <div key={ns.namespace} className="flex flex-wrap items-center gap-1 mt-1">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-0.5">
                  {ns.namespace}
                </span>
                {ns.tags.map((f) => (
                  <FacetChip
                    key={f.tag}
                    tag={f.tag}
                    count={f.count}
                    label={f.tag.slice(ns.namespace.length + 1)}
                    active={activeTags.includes(f.tag)}
                    onClick={() => toggleTag(f.tag)}
                  />
                ))}
              </div>
            ))}
        </div>
      )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function MemoriesPage() {
  const search = useReactiveSearch();
  const { queryParam: projectParam } = useProject();
  const isFamiliesView = readView(search) === "families";
  const isDuplicatesView = readView(search) === "duplicates";

  return (
    <div className="p-4 max-w-6xl mx-auto w-full space-y-4">
      {/* Page header with embeddings health indicator */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-base font-semibold text-foreground">Memories</h1>
        <MemoriesHealth />
      </div>

      {/* mt#4767: this is the widget redesign the mt#4762 PR #3492 R2 comment
          deferred to this task. MemoryStats' width cap is gone with it — the
          worklist tiles are a full-width 5-up grid, so there is no longer a
          narrow card stretched across the page. MemoryStats.tsx itself stays
          registered as a standalone widget for any other render context. */}
      <MemoriesCuration />

      <CohortSwitcher search={search} />

      {isFamiliesView ? (
        <MemoriesFamilies />
      ) : isDuplicatesView ? (
        /* Read-only content-hash rollup. Deliberately renders INSTEAD of the
           table (mt#4763's families precedent): a duplicate group is not a
           filtered slice of a flat list, and rendering it as one would drop
           the grouping that makes the population legible. */
        <MemoriesDuplicates />
      ) : (
        <>
          <FacetsRail search={search} projectParam={projectParam} />
          {/* Main list — self-navigating (row click -> /memory/:id), own toolbar
              (filters + search), sortable server-driven columns. */}
          <MemoriesList />
        </>
      )}
    </div>
  );
}

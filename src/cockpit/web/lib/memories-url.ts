/**
 * Shared `/memories` URL-state helpers (mt#4767).
 *
 * Extracted from `MemoriesPage.tsx`, which authored them for mt#4763's facet
 * rail and cohort switcher. mt#4767 adds a THIRD writer — the curation
 * worklists in `MemoriesCuration.tsx` — and a widget importing from the page
 * that renders it is a circular import. Rather than re-declare the key shape
 * a second time (exactly the drift PR #3500 R1 flagged when the provenance
 * namespace list existed in two places), both sides now import from here.
 *
 * `MemoriesPage.tsx` re-exports the read helpers so its existing test imports
 * keep resolving.
 *
 * ---------------------------------------------------------------------------
 * Why a synthetic `popstate`
 * ---------------------------------------------------------------------------
 * `MemoriesList` owns its filter state through `useListControls`, which reads
 * `window.location.search` into PRIVATE React state updated only by its own
 * actions or a genuine `popstate`. The facet rail, the cohort switcher and now
 * the worklists are SIBLINGS of that component, not parents, so they cannot
 * call into it. They instead write the URL exactly the way `useListControls`
 * does (`history.replaceState`, same `mem_f_<key>` shape) and then dispatch a
 * `popstate` by hand — which `replaceState` never fires on its own, but which
 * the existing listener treats identically to a real one.
 */
import { useEffect, useState } from "react";

export const MEM_PREFIX = "mem";
export const VIEW_PARAM = "mem_view";

/** The URL param name backing filter `key` — `tags` -> `mem_f_tags`. */
export function memFilterKey(key: string): string {
  return `${MEM_PREFIX}_f_${key}`;
}

export function readMemFilter(search: string, key: string): string {
  return new URLSearchParams(search).get(memFilterKey(key)) ?? "";
}

export function readView(search: string): string {
  return new URLSearchParams(search).get(VIEW_PARAM) ?? "";
}

export function parseTagList(value: string): string[] {
  return value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * `MemoriesList`'s own `DEFAULT_FILTERS.excludeSuperseded` is `"true"`, and
 * `useListControls`'s `setFilter` OMITS a param from the URL when it equals
 * the default — so an ABSENT `mem_f_excludeSuperseded` means "true", not
 * "unset". Any sibling computing counts must read the SAME default or its
 * numbers would disagree with the table for the (very common) never-touched
 * case.
 */
export function readExcludeSuperseded(search: string): "true" | "false" {
  const raw = readMemFilter(search, "excludeSuperseded");
  return raw === "false" ? "false" : "true";
}

/**
 * Write a batch of `mem_f_*`/`mem_view` values (`null` or `""` clears the key)
 * and reset pagination, mirroring `useListControls`'s own `setFilter` — then
 * notify any co-mounted `useListControls` instance via a synthetic `popstate`
 * (see the module docblock).
 */
export function writeMemoriesUrl(updates: Record<string, string | null>): void {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === "") params.delete(key);
    else params.set(key, value);
  }
  params.delete(`${MEM_PREFIX}_page`);
  const search = params.toString();
  const url = search ? `${window.location.pathname}?${search}` : window.location.pathname;
  window.history.replaceState(null, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Reactive copy of `window.location.search`, kept in sync via `popstate`. */
export function useReactiveSearch(): string {
  const [search, setSearch] = useState(() => window.location.search);
  useEffect(() => {
    const onPopState = () => setSearch(window.location.search);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  return search;
}

// ---------------------------------------------------------------------------
// Curation worklists (mt#4767)
// ---------------------------------------------------------------------------

/** The filter-shaped worklists — the ones that land on the ordinary table. */
export type FilterWorklistId = "untagged" | "neverRead" | "cold" | "superseded";

/** Every worklist, including the one that swaps the page VIEW instead. */
export type WorklistId = FilterWorklistId | "duplicates";

/**
 * The `mem_f_*` filter each worklist sets. Single-sourced so the button that
 * navigates and the predicate that decides "am I active" can never disagree —
 * the failure that would otherwise leave a worklist permanently unhighlighted
 * or, worse, highlighted while showing something else.
 *
 * `neverRead` maps to `neverAccessed` and NOT to `stale`: `stale` unions
 * never-read with read-but-old and so cannot express either alone. See
 * `MemoryListFilter`'s field docs for the measurement that forced the split.
 */
const WORKLIST_FILTER_KEY: Record<FilterWorklistId, string> = {
  untagged: "untagged",
  neverRead: "neverAccessed",
  cold: "cold",
  superseded: "onlySuperseded",
};

/** Every `mem_f_*` key a worklist owns — cleared when switching between them. */
const WORKLIST_KEYS = [
  ...Object.values(WORKLIST_FILTER_KEY),
  "coldDays",
  // mt#4763's cohort keys share the same URL space; a worklist click must
  // clear them or a stale cohort filter silently ANDs with the worklist and
  // narrows it below its own headline count.
  "tags",
  "since",
  "stale",
] as const;

function clearWorklistKeys(): Record<string, null> {
  const updates: Record<string, null> = { [VIEW_PARAM]: null };
  for (const key of WORKLIST_KEYS) updates[memFilterKey(key)] = null;
  return updates;
}

/**
 * Navigate to a worklist. `duplicates` swaps the page view (a content-hash
 * rollup is not a filtered slice of the table — the same reasoning mt#4763
 * applied to families); everything else is a URL filter over the same table.
 */
export function applyWorklist(id: WorklistId, coldDays?: number): void {
  if (id === "duplicates") {
    writeMemoriesUrl({ ...clearWorklistKeys(), [VIEW_PARAM]: "duplicates" });
    return;
  }
  const updates: Record<string, string | null> = {
    ...clearWorklistKeys(),
    [memFilterKey(WORKLIST_FILTER_KEY[id])]: "true",
  };
  if (id === "cold" && coldDays !== undefined) {
    updates[memFilterKey("coldDays")] = String(coldDays);
  }
  writeMemoriesUrl(updates);
}

/** Whether `search` is currently showing worklist `id`. */
export function isWorklistActive(search: string, id: WorklistId): boolean {
  if (id === "duplicates") return readView(search) === "duplicates";
  if (readView(search) !== "") return false;
  return readMemFilter(search, WORKLIST_FILTER_KEY[id]) === "true";
}

/** The active worklist, or null when the page is showing something else. */
export function activeWorklist(search: string): WorklistId | null {
  const ids: WorklistId[] = ["untagged", "neverRead", "cold", "superseded", "duplicates"];
  return ids.find((id) => isWorklistActive(search, id)) ?? null;
}

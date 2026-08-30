/**
 * useListControls — shared pagination / sort / filter hook (mt#1924)
 *
 * Reads and writes control state to the browser's URL query string via the
 * native History API (replaceState). Works without a router provider — the
 * cockpit app is a single-page dashboard, not a routed app.
 *
 * URL param conventions (clean URLs — defaults are never serialized):
 *   <prefix>_page=<n>           1-based page index (omitted when 1)
 *   <prefix>_pageSize=<n>       items per page (omitted at default)
 *   <prefix>_sort=<key>         sort key (omitted at default)
 *   <prefix>_dir=asc|desc       sort direction (omitted at default)
 *   <prefix>_f_<filterKey>=<v>  per-filter overrides (omitted at default)
 *
 * The hook subscribes to `popstate` so browser back/forward updates state.
 *
 * Generic over:
 *   T = item type
 *   S = sort-key string literal union
 *   F = filter-state object shape (all values are strings for URL compat)
 */

import { useCallback, useMemo, useState, useEffect, useRef } from "react";

export type SortDir = "asc" | "desc";

export interface UseListControlsOptions<T, S extends string, F extends Record<string, string>> {
  /** Full (unfiltered, unsorted) item list */
  items: T[];
  /** Default page size shown to operator */
  defaultPageSize: number;
  /** Default sort key */
  defaultSortKey: S;
  /** Default sort direction */
  defaultSortDir?: SortDir;
  /** Default filter state — all keys with their default values */
  defaultFilters: F;
  /** Returns true when `item` should be included given `filters` */
  filterFn: (item: T, filters: F) => boolean;
  /**
   * Comparator — return negative / zero / positive.
   * `dir` is the current sort direction; apply it inside the comparator.
   */
  sortFn: (a: T, b: T, key: S, dir: SortDir) => number;
  /** Available page-size options for the operator dropdown */
  pageSizeOptions?: number[];
  /**
   * Namespace prefix for URL params — use when two widgets share the same page.
   * e.g. prefix="ws" → ws_page, ws_sort, ws_f_status
   * Default: no prefix.
   */
  prefix?: string;
  /**
   * Server-driven mode (mt#4762). When provided, `pageItems` / `filteredCount`
   * / `totalCount` in the result are taken directly from this object instead
   * of being computed in memory from `items` via `filterFn`/`sortFn`/
   * pagination — for a caller (e.g. mt#4761's SQL-backed memories list) whose
   * query already applied filtering, sorting and paging server-side. The
   * hook still owns URL-param read/write, `popstate` handling, and the
   * same-key-toggles-direction rule — only the item-computation half is
   * bypassed. `items`/`filterFn`/`sortFn` are IGNORED in this mode (still
   * required by the type for the five existing client-mode adopters — pass
   * `[]` / no-ops when using server mode; see `readListControlsState` below
   * for reading `sortKey`/`page`/etc. BEFORE the server query exists, to
   * build its params).
   */
  server?: {
    /** The current page's items, already filtered/sorted/paginated server-side. */
    pageItems: T[];
    /** Total items matching the current filters (server-computed). */
    filteredCount: number;
    /**
     * Total items before filtering (server-computed). Callers whose query
     * doesn't separately track an unfiltered count may pass the same value
     * as `filteredCount`.
     */
    totalCount: number;
  };
}

export interface UseListControlsResult<T, S extends string, F extends Record<string, string>> {
  /** Currently visible page of items */
  pageItems: T[];
  /** Total items AFTER filtering (before pagination) */
  filteredCount: number;
  /** Total items BEFORE filtering */
  totalCount: number;
  /** Current 1-based page index */
  page: number;
  /** Number of items per page */
  pageSize: number;
  /** Total page count (based on filteredCount) */
  pageCount: number;
  /** Current sort key */
  sortKey: S;
  /** Current sort direction */
  sortDir: SortDir;
  /** Current filter values */
  filters: F;
  /** Available page-size options */
  pageSizeOptions: number[];
  /** Navigate to a specific page (1-based) */
  setPage: (page: number) => void;
  /** Change page size and reset to page 1 */
  setPageSize: (size: number) => void;
  /** Update sort: same key toggles direction; new key resets to defaultSortDir */
  setSort: (key: S) => void;
  /** Update a single filter value; resets to page 1 */
  setFilter: <K extends keyof F>(key: K, value: F[K]) => void;
  /** Reset all filters to defaults */
  clearFilters: () => void;
  /** True when any filter deviates from default */
  hasActiveFilters: boolean;
}

const DEFAULT_PAGE_SIZE_OPTIONS = [10, 25, 50];

// ---------------------------------------------------------------------------
// Pure helpers (no React deps) — exported for direct testing
// ---------------------------------------------------------------------------

function readSearchParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

function writeSearchParams(params: URLSearchParams): void {
  const search = params.toString();
  const url = search ? `${window.location.pathname}?${search}` : window.location.pathname;
  window.history.replaceState(null, "", url);
}

/** Prefix a URL param key */
export function prefixKey(prefix: string, k: string): string {
  return prefix ? `${prefix}_${k}` : k;
}

/** Apply a batch of updates (null = delete) to a URLSearchParams copy */
export function applyUpdates(
  base: URLSearchParams,
  updates: Record<string, string | null>
): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const [key, val] of Object.entries(updates)) {
    if (val === null) {
      next.delete(key);
    } else {
      next.set(key, val);
    }
  }
  return next;
}

/**
 * Serialize a `URLSearchParams` back into the `?`-prefixed string form the
 * hook stores as its `searchString` state (mt#4762 PR #3492 review) — an
 * empty param set serializes to `""`, never a bare `"?"`. Mirrors
 * `writeSearchParams`' own empty-case handling (below) so the hook's
 * internal state and the real `window.location.search` can never disagree:
 * without this, clearing every filter left `searchString` as the literal
 * string `"?"` while the browser's own query string read `""`.
 */
export function buildSearchStringState(params: URLSearchParams): string {
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

/** Compute total page count from item count and page size */
export function computePageCount(totalItems: number, pageSize: number): number {
  return Math.max(1, Math.ceil(totalItems / pageSize));
}

/** Slice a sorted array into a single page (1-based page index, clamped) */
export function paginateSlice<T>(items: T[], page: number, pageSize: number): T[] {
  const pc = computePageCount(items.length, pageSize);
  const safePage = Math.min(Math.max(1, page), pc);
  const start = (safePage - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

// ---------------------------------------------------------------------------
// URL-state parsing (mt#4762) — extracted so a server-driven caller can read
// page/sort/filter state via `readListControlsState` below WITHOUT rendering
// the hook, and so the hook body (further down) shares the exact same logic
// rather than a parallel copy that could drift.
// ---------------------------------------------------------------------------

export interface ListControlsStateOptions<S extends string, F extends Record<string, string>> {
  defaultPageSize: number;
  defaultSortKey: S;
  defaultSortDir?: SortDir;
  defaultFilters: F;
  pageSizeOptions?: number[];
  prefix?: string;
}

export interface ListControlsState<S extends string, F extends Record<string, string>> {
  page: number;
  pageSize: number;
  sortKey: S;
  sortDir: SortDir;
  filters: F;
}

function parseListControlsState<S extends string, F extends Record<string, string>>(
  search: string,
  opts: ListControlsStateOptions<S, F>
): ListControlsState<S, F> {
  const {
    defaultPageSize,
    defaultSortKey,
    defaultSortDir = "asc",
    defaultFilters,
    pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
    prefix = "",
  } = opts;

  const params = new URLSearchParams(search);
  const pk = (k: string) => prefixKey(prefix, k);

  const page = Math.max(1, Number(params.get(pk("page")) ?? 1));

  const pageSize = (() => {
    const raw = Number(params.get(pk("pageSize")) ?? defaultPageSize);
    return pageSizeOptions.includes(raw) ? raw : defaultPageSize;
  })();

  const sortKey = (params.get(pk("sort")) as S | null) ?? defaultSortKey;
  const sortDir = (params.get(pk("dir")) as SortDir | null) ?? defaultSortDir;

  const filters = { ...defaultFilters } as F;
  for (const key of Object.keys(defaultFilters) as (keyof F)[]) {
    const urlVal = params.get(pk(`f_${String(key)}`));
    if (urlVal !== null) {
      (filters as Record<string, string>)[String(key)] = urlVal;
    }
  }

  return { page, pageSize, sortKey, sortDir, filters };
}

/**
 * Read current page/sort/filter state directly from `window.location.search`
 * (mt#4762) — a plain, non-reactive read with no `useState`/`popstate`
 * subscription of its own.
 *
 * For a server-driven caller (see `UseListControlsOptions.server` above),
 * the sort/page/filter values needed to build the caller's OWN query are
 * needed BEFORE that query's result exists — and the result is what feeds
 * `server` into the full `useListControls` call. This breaks that ordering:
 * call this first to build the query, run the query, then pass its result
 * as `server` into `useListControls` (which independently computes the same
 * values from the same URL — see the hook body below — so the two never
 * diverge; only `useListControls` owns writes and `popstate` reactivity).
 */
export function readListControlsState<S extends string, F extends Record<string, string>>(
  opts: ListControlsStateOptions<S, F>
): ListControlsState<S, F> {
  return parseListControlsState(window.location.search, opts);
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

export function useListControls<T, S extends string, F extends Record<string, string>>(
  opts: UseListControlsOptions<T, S, F>
): UseListControlsResult<T, S, F> {
  const {
    items,
    defaultPageSize,
    defaultSortKey,
    defaultSortDir = "asc",
    defaultFilters,
    filterFn,
    sortFn,
    pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
    prefix = "",
  } = opts;

  // Store latest opts in a ref so callbacks can always read current values
  // without appearing in their dependency arrays (prevents stale closures
  // while keeping the callback identity stable across renders).
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Track search param string as state so React re-renders on URL changes
  const [searchString, setSearchString] = useState(() => window.location.search);

  // Subscribe to browser back/forward navigation
  useEffect(() => {
    const onPopState = () => setSearchString(window.location.search);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // ---------------------------------------------------------------------------
  // Read state from URL (fall back to defaults) — shares parseListControlsState
  // with the standalone `readListControlsState` export above (mt#4762), so
  // the two never diverge.
  // ---------------------------------------------------------------------------

  const { page, pageSize, sortKey, sortDir, filters } = useMemo(
    () =>
      parseListControlsState(searchString, {
        defaultPageSize,
        defaultSortKey,
        defaultSortDir,
        defaultFilters,
        pageSizeOptions,
        prefix,
      }),
    [
      searchString,
      defaultPageSize,
      defaultSortKey,
      defaultSortDir,
      defaultFilters,
      pageSizeOptions,
      prefix,
    ]
  );

  // ---------------------------------------------------------------------------
  // Derived: filter → sort → paginate (client mode), or pass through the
  // caller's already-computed query result (server mode, mt#4762).
  // ---------------------------------------------------------------------------

  const isServerMode = opts.server !== undefined;

  const filtered = useMemo(
    () => (isServerMode ? [] : items.filter((item) => filterFn(item, filters))),
    [items, filters, filterFn, isServerMode]
  );

  const sorted = useMemo(
    () => (isServerMode ? [] : [...filtered].sort((a, b) => sortFn(a, b, sortKey, sortDir))),
    [filtered, sortKey, sortDir, sortFn, isServerMode]
  );

  const filteredCount = isServerMode ? (opts.server?.filteredCount ?? 0) : sorted.length;
  const totalCount = isServerMode ? (opts.server?.totalCount ?? 0) : items.length;
  const pgCount = computePageCount(filteredCount, pageSize);
  const safePage = Math.min(page, pgCount);
  const pageItems = isServerMode
    ? (opts.server?.pageItems ?? [])
    : paginateSlice(sorted, safePage, pageSize);

  // ---------------------------------------------------------------------------
  // Write helpers — all read latest opts via optsRef to stay stable
  // ---------------------------------------------------------------------------

  const mergeAndFlush = useCallback((updates: Record<string, string | null>) => {
    const next = applyUpdates(readSearchParams(), updates);
    writeSearchParams(next);
    setSearchString(buildSearchStringState(next));
  }, []);

  const setPage = useCallback(
    (p: number) => {
      const pfx = optsRef.current.prefix ?? "";
      mergeAndFlush({ [prefixKey(pfx, "page")]: p <= 1 ? null : String(p) });
    },
    [mergeAndFlush]
  );

  const setPageSize = useCallback(
    (size: number) => {
      const { defaultPageSize: defSize, prefix: pfx = "" } = optsRef.current;
      mergeAndFlush({
        [prefixKey(pfx, "pageSize")]: size === defSize ? null : String(size),
        [prefixKey(pfx, "page")]: null,
      });
    },
    [mergeAndFlush]
  );

  const setSort = useCallback(
    (key: S) => {
      const {
        prefix: pfx = "",
        defaultSortKey: defKey,
        defaultSortDir: defDir = "asc",
      } = optsRef.current;
      // Read current sort state from URL directly (not stale closure)
      const currentParams = readSearchParams();
      const curKey = (currentParams.get(prefixKey(pfx, "sort")) as S | null) ?? defKey;
      const curDir = (currentParams.get(prefixKey(pfx, "dir")) as SortDir | null) ?? defDir;
      const newDir: SortDir = key === curKey ? (curDir === "asc" ? "desc" : "asc") : defDir;
      mergeAndFlush({
        [prefixKey(pfx, "sort")]: key === defKey && newDir === defDir ? null : key,
        [prefixKey(pfx, "dir")]: newDir === defDir ? null : newDir,
        [prefixKey(pfx, "page")]: null,
      });
    },
    [mergeAndFlush]
  );

  const setFilter = useCallback(
    <K extends keyof F>(key: K, value: F[K]) => {
      const { prefix: pfx = "", defaultFilters: defFilters } = optsRef.current;
      mergeAndFlush({
        [prefixKey(pfx, `f_${String(key)}`)]: value === defFilters[key] ? null : String(value),
        [prefixKey(pfx, "page")]: null,
      });
    },
    [mergeAndFlush]
  );

  const clearFilters = useCallback(() => {
    const { prefix: pfx = "", defaultFilters: defFilters } = optsRef.current;
    const updates: Record<string, null> = { [prefixKey(pfx, "page")]: null };
    for (const key of Object.keys(defFilters)) {
      updates[prefixKey(pfx, `f_${key}`)] = null;
    }
    mergeAndFlush(updates);
  }, [mergeAndFlush]);

  const hasActiveFilters = useMemo(() => {
    return Object.keys(defaultFilters).some(
      (k) => filters[k as keyof F] !== defaultFilters[k as keyof F]
    );
  }, [filters, defaultFilters]);

  return {
    pageItems,
    filteredCount,
    totalCount,
    page: safePage,
    pageSize,
    pageCount: pgCount,
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
  };
}

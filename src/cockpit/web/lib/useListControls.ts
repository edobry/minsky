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
// URL helpers (pure, no React deps)
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
function prefixKey(prefix: string, k: string): string {
  return prefix ? `${prefix}_${k}` : k;
}

/** Apply a batch of updates (null = delete) to a URLSearchParams copy */
function applyUpdates(
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

  const params = useMemo(() => new URLSearchParams(searchString), [searchString]);

  // ---------------------------------------------------------------------------
  // Read state from URL (fall back to defaults)
  // ---------------------------------------------------------------------------

  const pk = useCallback((k: string) => prefixKey(prefix, k), [prefix]);

  const page = Math.max(1, Number(params.get(pk("page")) ?? 1));

  const pageSize = (() => {
    const raw = Number(params.get(pk("pageSize")) ?? defaultPageSize);
    return pageSizeOptions.includes(raw) ? raw : defaultPageSize;
  })();

  const sortKey = (params.get(pk("sort")) as S | null) ?? defaultSortKey;
  const sortDir = (params.get(pk("dir")) as SortDir | null) ?? defaultSortDir;

  const filters = useMemo<F>(() => {
    const result = { ...defaultFilters } as F;
    for (const key of Object.keys(defaultFilters) as (keyof F)[]) {
      const urlVal = params.get(pk(`f_${String(key)}`));
      if (urlVal !== null) {
        (result as Record<string, string>)[String(key)] = urlVal;
      }
    }
    return result;
  }, [params, defaultFilters, pk]);

  // ---------------------------------------------------------------------------
  // Derived: filter → sort → paginate
  // ---------------------------------------------------------------------------

  const filtered = useMemo(
    () => items.filter((item) => filterFn(item, filters)),
    [items, filters, filterFn]
  );

  const sorted = useMemo(
    () => [...filtered].sort((a, b) => sortFn(a, b, sortKey, sortDir)),
    [filtered, sortKey, sortDir, sortFn]
  );

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * pageSize;
  const pageItems = sorted.slice(start, start + pageSize);

  // ---------------------------------------------------------------------------
  // Write helpers — all read latest opts via optsRef to stay stable
  // ---------------------------------------------------------------------------

  const mergeAndFlush = useCallback((updates: Record<string, string | null>) => {
    const next = applyUpdates(readSearchParams(), updates);
    writeSearchParams(next);
    setSearchString(`?${next.toString()}`);
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
    filteredCount: sorted.length,
    totalCount: items.length,
    page: safePage,
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
  };
}

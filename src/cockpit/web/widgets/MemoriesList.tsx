/**
 * MemoriesList widget frontend (mt#4762)
 *
 * Rebuild of the `/memories` table on top of mt#4761's SQL-side sort/page/
 * filter primitives and mt#1924's shared `useListControls` hook (the URL-param
 * contract, `popstate` handling, and same-key-toggles-direction rule five
 * other cockpit list surfaces already share). `/memories` is the list surface
 * that never adopted the hook — see the mt#4762 Planning Audit gate (p).
 *
 * `useListControls` pages a full `items: T[]` array IN MEMORY, which is
 * exactly the pattern mt#4761 moved into SQL to cut a 9.16 MB fetch to
 * 38 KB. Adopting the hook unchanged would re-import that fetch, so this
 * widget uses the hook's additive `server` mode (mt#4762): `pageItems` /
 * `filteredCount` / `totalCount` come from THIS widget's own query instead
 * of being computed by the hook from an `items` array. The hook still owns
 * URL-param read/write and `popstate` reactivity; only the item-computation
 * half is bypassed. See `useListControls.ts`'s `readListControlsState` doc
 * comment for why the query is built from a separate, non-reactive URL read
 * rather than from this same hook call's own output (ordering: the query's
 * params are needed before its own result can feed back into the hook).
 *
 * Two data sources feed the same table:
 *  - No search query: `memories-list` (mt#4761) — full server-side sort,
 *    filter (type/scope/excludeSuperseded) and pagination.
 *  - A search query is active: `memories-search` (semantic when embeddings
 *    are healthy, lexical fallback otherwise — same degraded banner as
 *    before). Its results are NOT paginated server-side (a bounded batch),
 *    so sort is applied client-side over that batch — the mechanism differs
 *    from list mode, but the sortKey/sortDir/URL contract does not; a header
 *    click behaves identically in both modes from the operator's chair.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, keepPreviousData, type UseQueryResult } from "@tanstack/react-query";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { cn } from "../lib/utils";
import type {
  MemoryRecord,
  MemoryType,
  MemoryScope,
  MemoryListSortField,
  MemorySummaryRecord,
} from "@minsky/domain/memory/types";
import { WidgetShell, type WidgetVariant } from "../components/WidgetShell";
import { useEntityIndex } from "../lib/use-entity-index";
import { LinkifiedText } from "../components/LinkifiedText";
import { useProject } from "../lib/project-context";
import { useListControls, readListControlsState, type SortDir } from "../lib/useListControls";
import { SortIndicator } from "../components/SortIndicator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Checkbox } from "../components/ui/checkbox";
import { Button } from "../components/ui/button";

// ---------------------------------------------------------------------------
// Payload shapes (mirror the `memories-list` / `memories-search` widgets —
// frontend code can't import `src/cockpit/widgets/*`, server-only, so these
// are declared locally against the shared `@minsky/domain` types both sides
// reference, same convention the pre-mt#4762 version of this file already
// used).
// ---------------------------------------------------------------------------

type MemoriesListRow = MemorySummaryRecord & { shortId?: string };

interface MemoriesListPayload {
  records: MemoriesListRow[];
  total: number;
}

interface MemorySearchResult {
  record: MemoryRecord;
  score: number;
}

interface MemoriesSearchPayload {
  results: MemorySearchResult[];
  backend: "embeddings" | "lexical" | "none";
  degraded: boolean;
  query: string;
}

/** The union `memories-list` accepts for `sort` (mt#4761) — re-exported under
 * a local name so the rest of this file reads as widget vocabulary. */
type MemorySortKey = MemoryListSortField;

// ---------------------------------------------------------------------------
// Unified row shape — both data sources project into this before rendering,
// so the table body doesn't care which one is active. `accessCount` is only
// ever present from search (`memories-list`'s payload is the content-free
// `MemorySummaryRecord` projection and doesn't carry it) — rendered as "—"
// when absent, same graceful-degradation convention as the rest of this app.
// ---------------------------------------------------------------------------

interface DisplayRow {
  id: string;
  shortId?: string;
  name: string;
  type: MemoryType;
  description: string;
  tags: string[];
  createdAt: string | Date;
  accessCount?: number;
}

function toDisplayRowFromSummary(r: MemoriesListRow): DisplayRow {
  return {
    id: r.id,
    shortId: r.shortId,
    name: r.name,
    type: r.type,
    description: r.description,
    tags: r.tags,
    createdAt: r.createdAt,
  };
}

function toDisplayRowFromRecord(r: MemoryRecord): DisplayRow {
  return {
    id: r.id,
    shortId: r.shortId,
    name: r.name,
    type: r.type,
    description: r.description,
    tags: r.tags,
    createdAt: r.createdAt,
    accessCount: r.accessCount,
  };
}

// ---------------------------------------------------------------------------
// Tag provenance demotion (mt#4762 success criterion)
//
// A namespace denylist with a stated basis, not a hand-picked string list:
// `imported-from:` and `content-hash:` are machine-provenance metadata (how
// a record entered the system / a dedup fingerprint), never something an
// operator scans for. The visible chip slots are filled ONLY from semantic
// tags — a provenance tag never occupies one, even when slots are left over
// (a weaker "semantic tags first, provenance fills leftover room" rule would
// satisfy the letter of "never occupy a slot while a semantic tag is
// hidden" but not AT4's literal case of a single semantic + a single
// provenance tag, where nothing is hidden yet the provenance tag still must
// not show). Provenance tags always count toward the "+N" overflow.
// ---------------------------------------------------------------------------

const PROVENANCE_TAG_NAMESPACES = new Set(["imported-from", "content-hash"]);
const VISIBLE_TAG_SLOTS = 3;

function tagNamespace(tag: string): string | null {
  const idx = tag.indexOf(":");
  return idx === -1 ? null : tag.slice(0, idx).toLowerCase();
}

function isProvenanceTag(tag: string): boolean {
  const ns = tagNamespace(tag);
  return ns !== null && PROVENANCE_TAG_NAMESPACES.has(ns);
}

// ---------------------------------------------------------------------------
// Relative time + absolute ISO title
// ---------------------------------------------------------------------------

function relativeTime(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  const diffMs = Date.now() - d.getTime();
  if (isNaN(diffMs)) return "—";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function absoluteIso(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  return isNaN(d.getTime()) ? "" : d.toISOString();
}

// ---------------------------------------------------------------------------
// Type badge
// ---------------------------------------------------------------------------

const TYPE_BADGE: Record<MemoryType, string> = {
  user: "bg-primary/20 text-primary",
  feedback: "bg-amber-500/20 text-amber-500",
  project: "bg-emerald-500/20 text-emerald-500",
  reference: "bg-muted text-muted-foreground",
};

function TypeBadge({ type }: { type: MemoryType }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 rounded text-xs capitalize flex-shrink-0",
        TYPE_BADGE[type]
      )}
    >
      {type}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Filters + sort config
// ---------------------------------------------------------------------------

const TYPE_OPTIONS = ["", "user", "feedback", "project", "reference"] as const;
const SCOPE_OPTIONS = ["", "project", "user", "cross_project"] as const;

/** Control-boundary sentinel for "no filter" (mt#3347) — see MemoriesFilters. */
const ALL_VALUE = "__all__";

interface MemoriesFilters extends Record<string, string> {
  type: MemoryType | "";
  scope: MemoryScope | "";
  excludeSuperseded: "true" | "false";
  /** Search query — folded into URL state so a searched view round-trips (AT3/AT6). */
  q: string;
}

const DEFAULT_FILTERS: MemoriesFilters = {
  type: "",
  scope: "",
  excludeSuperseded: "true",
  q: "",
};

const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZE_OPTIONS = [25, 50, 100];

interface SortColumn {
  key: MemorySortKey;
  label: string;
  className: string;
  align?: "right";
}

const SORT_COLUMNS: SortColumn[] = [
  { key: "shortId", label: "ID", className: "w-16 flex-shrink-0" },
  { key: "name", label: "Name", className: "flex-1 min-w-0" },
  { key: "accessCount", label: "Accesses", className: "w-20 flex-shrink-0 hidden md:block", align: "right" },
  { key: "created", label: "Created", className: "w-24 flex-shrink-0", align: "right" },
];

// ---------------------------------------------------------------------------
// Client-side sort (search mode only — memories-search returns a bounded,
// unpaginated batch; list mode never runs this, mt#4761's SQL ORDER BY does).
// ---------------------------------------------------------------------------

function parseShortIdNum(shortId: string | undefined): number {
  if (!shortId) return 0;
  const digits = /(\d+)/.exec(shortId)?.[1];
  return digits ? parseInt(digits, 10) : 0;
}

function memorySortFn(a: DisplayRow, b: DisplayRow, key: MemorySortKey, dir: SortDir): number {
  let cmp = 0;
  switch (key) {
    case "name":
      cmp = a.name.localeCompare(b.name);
      break;
    case "accessCount":
      cmp = (a.accessCount ?? 0) - (b.accessCount ?? 0);
      break;
    case "shortId":
      cmp = parseShortIdNum(a.shortId) - parseShortIdNum(b.shortId);
      break;
    case "created":
    case "updated":
    case "lastAccessed":
    default:
      cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      break;
  }
  return dir === "asc" ? cmp : -cmp;
}

// ---------------------------------------------------------------------------
// Request-param builders
// ---------------------------------------------------------------------------

interface UrlState {
  page: number;
  pageSize: number;
  sortKey: MemorySortKey;
  sortDir: SortDir;
  filters: MemoriesFilters;
}

function buildListParams(
  state: UrlState,
  projectParam: { project: string } | undefined
): Record<string, string> {
  const params: Record<string, string> = {
    sort: state.sortKey,
    dir: state.sortDir,
    limit: String(state.pageSize),
    offset: String((state.page - 1) * state.pageSize),
  };
  if (state.filters.type) params.type = state.filters.type;
  if (state.filters.scope) params.scope = state.filters.scope;
  if (state.filters.excludeSuperseded === "true") params.excludeSuperseded = "true";
  if (projectParam) params.project = projectParam.project;
  return params;
}

function buildSearchParams(
  state: UrlState,
  projectParam: { project: string } | undefined
): Record<string, string> {
  const params: Record<string, string> = { q: state.filters.q.trim() };
  if (projectParam) params.project = projectParam.project;
  return params;
}

/** "51–100 of 1,326" (mt#4762 success criterion — true total, not a rendered-page count). */
function formatRange(page: number, pageSize: number, filteredCount: number): string {
  if (filteredCount === 0) return "0 of 0";
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, filteredCount);
  return `${start.toLocaleString()}–${end.toLocaleString()} of ${filteredCount.toLocaleString()}`;
}

// ---------------------------------------------------------------------------
// Toolbar — filters + the search box folded in (mt#4762: "one surface")
// ---------------------------------------------------------------------------

function MemoriesToolbar({
  inputValue,
  onSearchInput,
  filters,
  onFilterChange,
  pageSize,
  pageSizeOptions,
  onPageSize,
}: {
  inputValue: string;
  onSearchInput: (value: string) => void;
  filters: MemoriesFilters;
  onFilterChange: <K extends keyof MemoriesFilters>(key: K, value: MemoriesFilters[K]) => void;
  pageSize: number;
  pageSizeOptions: number[];
  onPageSize: (size: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 py-2 mb-2 border-b border-border text-xs">
      <input
        type="search"
        placeholder="Search memories…"
        value={inputValue}
        onChange={(e) => onSearchInput(e.target.value)}
        className="h-7 rounded border border-border bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground w-48 focus:outline-none focus:ring-1 focus:ring-ring"
        aria-label="Search memories"
      />

      <Select
        value={filters.type === "" ? ALL_VALUE : filters.type}
        onValueChange={(v) => onFilterChange("type", v === ALL_VALUE ? "" : (v as MemoryType))}
      >
        <SelectTrigger className="h-7" aria-label="Filter by type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>All types</SelectItem>
          {TYPE_OPTIONS.filter(Boolean).map((t) => (
            <SelectItem key={t} value={t}>
              {t}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.scope === "" ? ALL_VALUE : filters.scope}
        onValueChange={(v) => onFilterChange("scope", v === ALL_VALUE ? "" : (v as MemoryScope))}
      >
        <SelectTrigger className="h-7" aria-label="Filter by scope">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_VALUE}>All scopes</SelectItem>
          {SCOPE_OPTIONS.filter(Boolean).map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <label className="flex items-center gap-1 text-muted-foreground cursor-pointer">
        <Checkbox
          checked={filters.excludeSuperseded === "true"}
          onCheckedChange={(v) => onFilterChange("excludeSuperseded", v === true ? "true" : "false")}
          className="h-3 w-3"
        />
        Hide superseded
      </label>

      <div className="ml-auto flex items-center gap-1.5">
        <span className="text-muted-foreground">Per page:</span>
        <Select value={String(pageSize)} onValueChange={(v) => onPageSize(Number(v))}>
          <SelectTrigger className="h-7 bg-background" title="Items per page">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {pageSizeOptions.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table header
// ---------------------------------------------------------------------------

function MemoriesTableHeader({
  sortKey,
  sortDir,
  onSort,
}: {
  sortKey: MemorySortKey;
  sortDir: SortDir;
  onSort: (key: MemorySortKey) => void;
}) {
  return (
    <div className="flex items-center gap-3 py-1.5 mb-0.5 border-b border-border">
      {SORT_COLUMNS.map((col) => (
        <button
          key={col.key}
          onClick={() => onSort(col.key)}
          className={cn(
            "text-eyebrow font-mono uppercase text-muted-foreground hover:text-foreground transition-colors",
            col.className,
            col.align === "right" ? "text-right" : "text-left"
          )}
        >
          {col.label}
          <SortIndicator active={sortKey === col.key} dir={sortDir} />
        </button>
      ))}
      <span className="w-8 flex-shrink-0 hidden lg:block" aria-hidden="true" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function MemoriesRowItem({ row, onRowClick }: { row: DisplayRow; onRowClick: (id: string) => void }) {
  const entityIndex = useEntityIndex();
  const semanticTags = row.tags.filter((t) => !isProvenanceTag(t));
  const visibleTags = semanticTags.slice(0, VISIBLE_TAG_SLOTS);
  const overflow = row.tags.length - visibleTags.length;

  return (
    <div
      onClick={() => onRowClick(row.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onRowClick(row.id);
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`View details for ${row.name}`}
      className="flex items-center gap-3 py-1.5 border-b border-border/50 last:border-0 cursor-pointer hover:bg-muted/30 transition-colors rounded-sm"
    >
      <span className="w-16 flex-shrink-0 font-mono text-small text-foreground">
        {row.shortId ?? "—"}
      </span>
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <TypeBadge type={row.type} />
        <div className="min-w-0 flex-1">
          <div className="text-body truncate" title={row.name}>
            {row.name}
          </div>
          {row.description && (
            <div className="text-small text-muted-foreground truncate" title={row.description}>
              <LinkifiedText text={row.description} index={entityIndex} />
            </div>
          )}
        </div>
      </div>
      <span className="w-20 flex-shrink-0 text-right tabular-nums text-small text-muted-foreground hidden md:block">
        {row.accessCount !== undefined && row.accessCount > 0 ? row.accessCount : "—"}
      </span>
      <span
        className="w-24 flex-shrink-0 text-right tabular-nums text-small text-muted-foreground"
        title={absoluteIso(row.createdAt)}
      >
        {relativeTime(row.createdAt)}
      </span>
      <div className="w-8 flex-shrink-0 hidden lg:flex flex-wrap justify-end gap-0.5">
        {visibleTags.map((tag) => (
          <span
            key={tag}
            className="px-1 py-0.5 rounded bg-muted text-muted-foreground text-[10px] whitespace-nowrap"
          >
            {tag}
          </span>
        ))}
        {overflow > 0 && <span className="text-muted-foreground text-[10px]">+{overflow}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function MemoriesPaginationBar({
  page,
  pageCount,
  pageSize,
  filteredCount,
  disabled,
  onPage,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  filteredCount: number;
  /** True while search mode is active — server-mode paging is list-only. */
  disabled: boolean;
  onPage: (p: number) => void;
}) {
  return (
    <div className="flex items-center justify-between pt-2 mt-1 border-t border-border">
      <span className="text-small text-muted-foreground tabular-nums">
        {formatRange(page, pageSize, filteredCount)}
      </span>
      {!disabled && pageCount > 1 && (
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
          <span className="text-small text-muted-foreground px-1 tabular-nums">
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
// Server-payload projection for useListControls' `server` mode
// ---------------------------------------------------------------------------

function computeServerPayload(
  data: WidgetData | undefined,
  isSearching: boolean,
  sortKey: MemorySortKey,
  sortDir: SortDir
): { pageItems: DisplayRow[]; filteredCount: number; totalCount: number } | undefined {
  if (!data || data.state !== "ok") return undefined;

  if (isSearching) {
    const payload = data.payload as MemoriesSearchPayload;
    const rows = payload.results.map(({ record }) => toDisplayRowFromRecord(record));
    const sorted = [...rows].sort((a, b) => memorySortFn(a, b, sortKey, sortDir));
    return { pageItems: sorted, filteredCount: sorted.length, totalCount: sorted.length };
  }

  const payload = data.payload as MemoriesListPayload;
  return {
    pageItems: payload.records.map(toDisplayRowFromSummary),
    filteredCount: payload.total,
    totalCount: payload.total,
  };
}

// ---------------------------------------------------------------------------
// Inner widget — orchestrates the two queries + useListControls' server mode
// ---------------------------------------------------------------------------

function MemoriesListInner({
  onRowClick,
  selectedSlug,
  projectParam,
}: {
  onRowClick: (id: string) => void;
  selectedSlug: string | null;
  projectParam: { project: string } | undefined;
}) {
  // Non-reactive URL read (mt#4762) — built BEFORE the full useListControls
  // call below so its sort/page/filter values can drive this widget's OWN
  // query; see the header doc comment and useListControls.ts's
  // `readListControlsState` for why the ordering has to run this direction.
  const urlState = readListControlsState<MemorySortKey, MemoriesFilters>({
    defaultPageSize: DEFAULT_PAGE_SIZE,
    defaultSortKey: "created",
    defaultSortDir: "desc",
    defaultFilters: DEFAULT_FILTERS,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
    prefix: "mem",
  });

  const isSearching = urlState.filters.q.trim().length > 0;

  // Local input text updates immediately on keystroke; the URL `q` filter
  // (and therefore the actual search request) updates after a 300ms
  // debounce — same debounce window MemorySearch already used.
  const [inputValue, setInputValue] = useState(urlState.filters.q);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);
  // Keep the input in sync with URL-driven changes this component didn't
  // originate itself — e.g. browser back/forward, or a bookmarked URL.
  // Deliberately keyed on the URL value alone, not `inputValue` (which this
  // effect writes) — including it would re-run on every keystroke.
  useEffect(() => {
    setInputValue(urlState.filters.q);
  }, [urlState.filters.q]);

  const listQuery = useQuery<WidgetData, Error>({
    queryKey: [
      "widget",
      "memories-list",
      urlState.sortKey,
      urlState.sortDir,
      urlState.page,
      urlState.pageSize,
      urlState.filters.type,
      urlState.filters.scope,
      urlState.filters.excludeSuperseded,
      selectedSlug,
    ],
    queryFn: () => fetchWidgetData("memories-list", buildListParams(urlState, projectParam)),
    enabled: !isSearching,
    staleTime: 25_000,
    refetchInterval: isSearching ? false : 30_000,
    // A sort/page/filter change is a NEW queryKey, so without this every
    // click would blank the table to "Loading…" while the new page fetches
    // (mt#4762 — caught by AT2's second click, which clicked a header
    // button that had just been unmounted by the loading flash).
    placeholderData: keepPreviousData,
  });

  const searchQuery = useQuery<WidgetData, Error>({
    queryKey: ["widget", "memories-search", urlState.filters.q, selectedSlug],
    queryFn: () => fetchWidgetData("memories-search", buildSearchParams(urlState, projectParam)),
    enabled: isSearching,
    staleTime: 20_000,
    placeholderData: keepPreviousData,
  });

  const activeQuery: UseQueryResult<WidgetData, Error> = isSearching ? searchQuery : listQuery;

  const server = useMemo(
    () => computeServerPayload(activeQuery.data, isSearching, urlState.sortKey, urlState.sortDir),
    [activeQuery.data, isSearching, urlState.sortKey, urlState.sortDir]
  );

  const controls = useListControls<DisplayRow, MemorySortKey, MemoriesFilters>({
    items: [],
    defaultPageSize: DEFAULT_PAGE_SIZE,
    defaultSortKey: "created",
    defaultSortDir: "desc",
    defaultFilters: DEFAULT_FILTERS,
    filterFn: () => true,
    sortFn: () => 0,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
    prefix: "mem",
    server,
  });

  function handleSearchInput(value: string) {
    setInputValue(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      controls.setFilter("q", value);
    }, 300);
  }

  const toolbar = (
    <MemoriesToolbar
      inputValue={inputValue}
      onSearchInput={handleSearchInput}
      filters={controls.filters}
      onFilterChange={controls.setFilter}
      pageSize={controls.pageSize}
      pageSizeOptions={controls.pageSizeOptions}
      onPageSize={controls.setPageSize}
    />
  );

  if (activeQuery.isLoading || !activeQuery.data) {
    return (
      <>
        {toolbar}
        <p className="text-xs text-muted-foreground py-8 text-center">Loading…</p>
      </>
    );
  }

  if (activeQuery.isError || activeQuery.data.state === "degraded") {
    const reason = activeQuery.isError
      ? activeQuery.error.message
      : (activeQuery.data as { reason: string }).reason;
    return (
      <>
        {toolbar}
        <p className="text-xs text-muted-foreground">{reason}</p>
      </>
    );
  }

  const searchPayload = isSearching
    ? (activeQuery.data.payload as MemoriesSearchPayload)
    : undefined;
  const showDegradedBanner =
    isSearching && searchPayload && (searchPayload.degraded || searchPayload.backend === "lexical");

  return (
    <>
      {toolbar}
      {showDegradedBanner && (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-500 mb-2">
          {searchPayload?.degraded
            ? "Embeddings provider is degraded or unavailable. Showing lexical fallback results — semantic similarity unavailable."
            : "Showing lexical search results. Semantic similarity unavailable."}
        </div>
      )}
      {controls.pageItems.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-8 px-4">
          {isSearching ? `No memories match "${urlState.filters.q}".` : "No memories match the current filters."}
        </p>
      ) : (
        <div className="overflow-x-auto -mx-6 px-6">
          <MemoriesTableHeader
            sortKey={controls.sortKey}
            sortDir={controls.sortDir}
            onSort={controls.setSort}
          />
          {controls.pageItems.map((row) => (
            <MemoriesRowItem key={row.id} row={row} onRowClick={onRowClick} />
          ))}
          <MemoriesPaginationBar
            page={controls.page}
            pageCount={controls.pageCount}
            pageSize={controls.pageSize}
            filteredCount={controls.filteredCount}
            disabled={isSearching}
            onPage={controls.setPage}
          />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main widget export (mt#2373)
// ---------------------------------------------------------------------------

interface MemoriesListProps {
  /**
   * Row-click navigation hook; defaults to an in-app navigation to
   * `/memory/:id`. Signature is `(id: string) => void` rather than the
   * pre-mt#4762 `(record: MemoryRecord) => void` — the row's own data
   * varies by source (the SQL-list path projects to the lighter
   * `DisplayRow`, not a full `MemoryRecord`; only search mode has one), and
   * `id` is the one field every row shape guarantees. The only pre-existing
   * consumer, `MemoriesPage.tsx`, no longer passes this callback at all
   * (mt#4762 made the widget self-navigating via `useNavigate`), so no
   * caller depends on the old signature.
   */
  onRowClick?: (id: string) => void;
  /** Render-context variant; defaults to the home-grid card frame. */
  variant?: WidgetVariant;
  /** Title from the registry; defaults to the widget's canonical title for back-compat. */
  title?: string;
}

export function MemoriesList({ onRowClick, variant = "card", title = "Memories" }: MemoriesListProps) {
  const { selectedSlug, queryParam: projectParam } = useProject();
  const navigate = useNavigate();
  const navigateToMemory = (id: string) => {
    navigate(`/memory/${encodeURIComponent(id)}`);
  };

  return (
    <WidgetShell variant={variant} title={title}>
      <MemoriesListInner
        onRowClick={onRowClick ?? navigateToMemory}
        selectedSlug={selectedSlug}
        projectParam={projectParam}
      />
    </WidgetShell>
  );
}

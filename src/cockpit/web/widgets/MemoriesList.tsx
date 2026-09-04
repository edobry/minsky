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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  useBulkRetagMemories,
  useBulkDeleteMemories,
  type BulkRetagPreview,
  type BulkDeletePreview,
} from "../lib/memory-mutations";

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
/**
 * Reserved width for the tags column — shared by the header spacer and each
 * row's tag cell so the two stay aligned (mt#4762 PR #3492 R2). This used to
 * be `w-8` (32px), nowhere near enough for real chip text ("memory-hygiene"
 * alone is ~90px at this font size); each chip is also individually
 * `max-w-[64px] truncate` and the cell itself carries `overflow-hidden` as a
 * second line of defense, so nothing here can bleed into the Created cell
 * immediately to its left again regardless of how long a tag's name is.
 */
const TAGS_COLUMN_WIDTH_CLASS = "w-32 flex-shrink-0";

function tagNamespace(tag: string): string | null {
  const idx = tag.indexOf(":");
  return idx === -1 ? null : tag.slice(0, idx).toLowerCase();
}

function isProvenanceTag(tag: string): boolean {
  const ns = tagNamespace(tag);
  return ns !== null && PROVENANCE_TAG_NAMESPACES.has(ns);
}

// ---------------------------------------------------------------------------
// Handoff name parsing (mt#4763 success criterion)
//
// `.minsky/skills/handoff/SKILL.md`'s naming convention is
// `handoff_<cluster-slug>_<date>` — a raw snake_case string with the date
// baked into the tail. A record only gets this treatment when it actually
// carries the `handoff` tag AND its name matches the convention; anything
// else renders its raw name unchanged (this is a display transform, never a
// rewrite of stored data).
// ---------------------------------------------------------------------------

const HANDOFF_NAME_PATTERN = /^handoff_(.+)_(\d{4}-\d{2}-\d{2})$/;

interface ParsedHandoffName {
  slug: string;
  date: string;
}

/** Parse a `handoff_<slug>_<date>` name; returns null when it doesn't match. */
export function parseHandoffName(name: string): ParsedHandoffName | null {
  const match = HANDOFF_NAME_PATTERN.exec(name);
  if (!match) return null;
  const [, rawSlug, date] = match;
  if (!rawSlug || !date) return null;
  return { slug: rawSlug.replace(/_/g, " "), date };
}

/**
 * The visible label for a memory row/detail title (mt#4763). For a
 * `handoff`-tagged record whose name matches the convention, the cluster
 * slug becomes the visible label rather than the raw snake_case name — the
 * date is still available via the row's own Created column / detail
 * metadata, so it isn't duplicated into the label.
 */
export function formatMemoryDisplayName(name: string, tags: string[]): string {
  if (!tags.includes("handoff")) return name;
  const parsed = parseHandoffName(name);
  return parsed ? parsed.slug : name;
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
  /**
   * Comma-separated tag list, AND semantics (mt#4763) — mirrors the
   * `memories-list` widget's own `parseTags` convention (a comma-joined
   * string, since the widget-dispatch route silently drops repeated
   * `?tags=a&tags=b` query keys; see `memories-list.ts`'s `parseTags` doc
   * comment). Driven by the facet rail (`MemoriesPage.tsx`, multi-select
   * toggle) AND by clicking a tag chip in a row or on the detail page
   * (single-tag replace) — both write this SAME URL param
   * (`mem_f_tags`), which is what lets a facet click and a row click
   * converge on one filtered view (AT4/AT6).
   */
  tags: string;
  /** ISO date lower bound — drives the "Recent" cohort preset (mt#4763). */
  since: string;
  /**
   * `"true"` for the never-read-OR-cold UNION — drives the cohort preset
   * mt#4763 shipped as "Stale" and mt#4767 relabelled to "Cold".
   *
   * Renamed from `stale` by mt#4799, matching `MemoryListFilter.unreadOrCold`.
   * The legacy `mem_f_stale` URL key is still READ (see `readFilters`), so
   * already-shared links keep working; only the name in code changed.
   * New work should reach for `cold` below, which is the disjoint filter;
   * this one unions never-read in and cannot separate the two.
   */
  unreadOrCold: "true" | "false";
  /**
   * LEGACY read-only alias for {@link unreadOrCold} (mt#4799 back-compat shim).
   *
   * It has to stay a FIELD, not just a name the page recognises: the URL→state
   * reader is driven by {@link DEFAULT_FILTERS}'s key set, so a key absent
   * there is never read off the query string at all. Dropping it would leave
   * `?mem_f_stale=true` lighting the Cold chip (`MemoriesPage` still reads the
   * old key) while the TABLE below silently ignored the filter — worse than
   * either keeping it or breaking it cleanly.
   *
   * Nothing WRITES this key any more. `buildListParams` folds it into
   * `unreadOrCold`, so the domain surface never sees the old name.
   */
  stale: "true" | "false";
  /** `"true"` for records with no tags — mt#4767's Untagged worklist. */
  untagged: "true" | "false";
  /** `"true"` for records never read since creation — mt#4767's Never-read worklist. */
  neverAccessed: "true" | "false";
  /** `"true"` for records read once and not since — mt#4767's Cold worklist. */
  cold: "true" | "false";
  /** Cold threshold in days; empty means the domain default (14). */
  coldDays: string;
  /** `"true"` for superseded records only — mt#4767's Superseded worklist. */
  onlySuperseded: "true" | "false";
}

/** Exported alongside {@link buildListParams} so a test can start from the real
 * production defaults rather than a hand-built object that could drift from them. */
export const DEFAULT_FILTERS: MemoriesFilters = {
  type: "",
  scope: "",
  excludeSuperseded: "true",
  q: "",
  tags: "",
  since: "",
  unreadOrCold: "false",
  // Legacy alias, read-only (mt#4799) — see MemoriesFilters.stale.
  stale: "false",
  untagged: "false",
  neverAccessed: "false",
  cold: "false",
  coldDays: "",
  onlySuperseded: "false",
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

/**
 * Exported for direct assertion (mt#4767). This is a pure state -> request-params
 * function — the observable the filter plumbing actually produces — so testing it
 * needs no render and no fetch mock. Worth pinning because one of its rules is
 * non-obvious and fails SILENTLY: the superseded worklist has to delete the
 * default `excludeSuperseded`, or it renders a plausible empty list rather than
 * an error.
 */
export function buildListParams(
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
  if (state.filters.tags) params.tags = state.filters.tags;
  if (state.filters.since) params.since = state.filters.since;
  // mt#4799: either the current key or the legacy `mem_f_stale` alias sends the
  // current param, so a bookmarked link produces the same request it always did.
  if (state.filters.unreadOrCold === "true" || state.filters.stale === "true") {
    params.unreadOrCold = "true";
  }
  // mt#4767 curation worklists. Each is sent only when active, so an
  // untouched view sends nothing new and the request shape is unchanged for
  // every existing caller.
  if (state.filters.untagged === "true") params.untagged = "true";
  if (state.filters.neverAccessed === "true") params.neverAccessed = "true";
  if (state.filters.cold === "true") {
    params.cold = "true";
    // Only sent alongside `cold` — on its own it would read as a threshold
    // for a filter that isn't running.
    if (state.filters.coldDays) params.coldDays = state.filters.coldDays;
  }
  if (state.filters.onlySuperseded === "true") {
    params.onlySuperseded = "true";
    // The superseded worklist has to see superseded rows, and
    // DEFAULT_FILTERS.excludeSuperseded is "true" — so without this the
    // worklist would reliably render empty, which is the worst kind of wrong
    // (a plausible zero rather than an error). The two filters are
    // contradictory by construction; this resolves it in the only direction
    // that makes the view meaningful.
    delete params.excludeSuperseded;
  }
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

      {/* mt#4767: the superseded worklist OVERRIDES this control, so it must
          not keep asserting the opposite. `onlySuperseded` and
          `excludeSuperseded` are contradictory and `excludeSuperseded`
          defaults to "true" — so on that worklist the checkbox would render
          TICKED above a table containing nothing but superseded records.

          Deriving the rendered state here (rather than only writing the URL in
          applyWorklist) covers the case a click-path fix cannot: a shared or
          bookmarked `?mem_f_onlySuperseded=true` link, which never goes
          through applyWorklist at all. Disabled rather than merely unticked,
          because on this worklist the filter genuinely has no effect — a
          control that looks live and does nothing is the same lie in a
          quieter register. */}
      {(() => {
        const overridden = filters.onlySuperseded === "true";
        return (
          <label
            className={cn(
              "flex items-center gap-1 text-muted-foreground",
              overridden ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
            )}
            title={
              overridden
                ? "Not applicable while the Superseded worklist is active — it shows superseded records by definition."
                : undefined
            }
          >
            <Checkbox
              checked={!overridden && filters.excludeSuperseded === "true"}
              disabled={overridden}
              onCheckedChange={(v) =>
                onFilterChange("excludeSuperseded", v === true ? "true" : "false")
              }
              className="h-3 w-3"
            />
            Hide superseded
          </label>
        );
      })()}

      {/* Active tag filter, cleared from a single control (mt#4763) — the tag
          itself may have been set by a facet-rail click, a row click, or a
          detail-page click; this is the one place to back out of all of them. */}
      {filters.tags && (
        <div className="flex items-center gap-1 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-primary">
          <span className="font-mono">{filters.tags.split(",").join(" + ")}</span>
          <button
            type="button"
            onClick={() => onFilterChange("tags", "")}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Clear tag filter"
          >
            ×
          </button>
        </div>
      )}

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
// Bulk selection actions (mt#4766) — dry-run-first per
// `operational-safety-dry-run-first`: a preview of exactly which records
// change is shown before any write, and the API caps a direct bulk write at
// BULK_RECORD_CAP (10) records — over that requires a task wrapper.
// ---------------------------------------------------------------------------

function BulkRetagDialog({
  ids,
  open,
  onOpenChange,
  onDone,
}: {
  ids: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [tagsInput, setTagsInput] = useState("");
  const [preview, setPreview] = useState<BulkRetagPreview | null>(null);
  const mutation = useBulkRetagMemories();

  const close = (next: boolean) => {
    if (!next) {
      setPreview(null);
      mutation.reset();
    }
    onOpenChange(next);
  };

  const tags = tagsInput
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const runPreview = () => {
    mutation.mutate(
      { ids, tags, execute: false },
      { onSuccess: (data) => setPreview(data as BulkRetagPreview) }
    );
  };

  const runExecute = () => {
    mutation.mutate({ ids, tags, execute: true }, { onSuccess: () => onDone() });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Retag {ids.length} selected records</DialogTitle>
          <DialogDescription>
            Sets these tags on every selected record (replaces existing tags). Preview first —
            nothing is written until you confirm.
          </DialogDescription>
        </DialogHeader>
        <input
          value={tagsInput}
          onChange={(e) => {
            setTagsInput(e.target.value);
            setPreview(null);
          }}
          aria-label="New tags"
          placeholder="Tags (comma-separated)"
          className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
        />
        {mutation.isError && (
          <p className="text-xs text-destructive" role="alert">
            {mutation.error instanceof Error ? mutation.error.message : "Bulk retag failed."}
          </p>
        )}
        {preview && (
          <ul className="max-h-48 overflow-y-auto space-y-1 rounded border border-border p-2 text-xs">
            {preview.changes.map((c) => (
              <li key={c.id} className="flex justify-between gap-2">
                <span className="truncate">{c.name ?? c.id}</span>
                <span className="text-muted-foreground font-mono">
                  {(c.currentTags ?? []).join("|") || "—"} → {c.newTags.join("|") || "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          {preview ? (
            <Button size="sm" disabled={mutation.isPending} onClick={runExecute}>
              {mutation.isPending ? "Applying…" : `Apply to ${ids.length}`}
            </Button>
          ) : (
            <Button size="sm" disabled={mutation.isPending || tags.length === 0} onClick={runPreview}>
              {mutation.isPending ? "Loading…" : "Preview"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BulkDeleteDialog({
  ids,
  open,
  onOpenChange,
  onDone,
}: {
  ids: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [preview, setPreview] = useState<BulkDeletePreview | null>(null);
  const mutation = useBulkDeleteMemories();

  const close = (next: boolean) => {
    if (!next) {
      setPreview(null);
      mutation.reset();
    }
    onOpenChange(next);
  };

  const runPreview = () => {
    mutation.mutate(
      { ids, execute: false },
      { onSuccess: (data) => setPreview(data as BulkDeletePreview) }
    );
  };

  const runExecute = () => {
    mutation.mutate({ ids, execute: true }, { onSuccess: () => onDone() });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Delete {ids.length} selected records</DialogTitle>
          <DialogDescription>
            Hard delete — row and best-effort embedding removed for each. Memory has no short-id
            tombstone table, so a deleted record's short id can be reissued later. Preview first.
          </DialogDescription>
        </DialogHeader>
        {mutation.isError && (
          <p className="text-xs text-destructive" role="alert">
            {mutation.error instanceof Error ? mutation.error.message : "Bulk delete failed."}
          </p>
        )}
        {preview && (
          <ul className="max-h-48 overflow-y-auto space-y-1 rounded border border-border p-2 text-xs">
            {preview.changes.map((c) => (
              <li key={c.id} className="truncate">
                {c.name || c.id}
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          {preview ? (
            <Button size="sm" variant="destructive" disabled={mutation.isPending} onClick={runExecute}>
              {mutation.isPending ? "Deleting…" : `Delete ${ids.length}`}
            </Button>
          ) : (
            <Button size="sm" variant="destructive" disabled={mutation.isPending} onClick={runPreview}>
              {mutation.isPending ? "Loading…" : "Preview"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BulkActionsBar({
  selectedIds,
  onClear,
}: {
  selectedIds: string[];
  onClear: () => void;
}) {
  const [dialog, setDialog] = useState<"retag" | "delete" | null>(null);

  return (
    <div className="flex items-center gap-2 py-1.5 mb-1 px-2 rounded border border-primary/30 bg-primary/5 text-xs">
      <span>{selectedIds.length} selected</span>
      <Button size="sm" variant="outline" className="h-6 px-2" onClick={() => setDialog("retag")}>
        Retag
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-6 px-2 text-destructive"
        onClick={() => setDialog("delete")}
      >
        Delete
      </Button>
      <button
        type="button"
        onClick={onClear}
        className="ml-auto text-muted-foreground hover:text-foreground"
      >
        Clear selection
      </button>

      <BulkRetagDialog
        ids={selectedIds}
        open={dialog === "retag"}
        onOpenChange={(o) => setDialog(o ? "retag" : null)}
        onDone={() => {
          setDialog(null);
          onClear();
        }}
      />
      <BulkDeleteDialog
        ids={selectedIds}
        open={dialog === "delete"}
        onOpenChange={(o) => setDialog(o ? "delete" : null)}
        onDone={() => {
          setDialog(null);
          onClear();
        }}
      />
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
  allOnPageSelected,
  onToggleAll,
}: {
  sortKey: MemorySortKey;
  sortDir: SortDir;
  onSort: (key: MemorySortKey) => void;
  allOnPageSelected: boolean;
  onToggleAll: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 py-1.5 mb-0.5 border-b border-border">
      <Checkbox
        checked={allOnPageSelected}
        onCheckedChange={(v) => onToggleAll(v === true)}
        aria-label="Select all on page"
        className="flex-shrink-0"
      />
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
      {/* Not sortable (no server field to sort tags by), so a static label
          rather than a SORT_COLUMNS entry — but it MUST reserve the same
          width as the row's tag cell below, or header/row columns misalign.
          mt#4762 PR #3492 R2: this used to be an unlabeled w-8 (32px) spacer,
          nowhere near wide enough for real chip content, which is why tags
          overflowed their box and painted over Created — see TAGS_COLUMN_WIDTH_CLASS. */}
      <span
        className={cn(
          TAGS_COLUMN_WIDTH_CLASS,
          "hidden lg:block text-eyebrow font-mono uppercase text-muted-foreground text-right"
        )}
      >
        Tags
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function MemoriesRowItem({
  row,
  onRowClick,
  onTagClick,
  selected,
  onToggleSelected,
}: {
  row: DisplayRow;
  onRowClick: (id: string) => void;
  /** Clicking a tag chip filters the list to that tag (mt#4763 AT6) — never opens the row. */
  onTagClick: (tag: string) => void;
  /** Bulk-selection state (mt#4766) — checkbox click never opens the row. */
  selected: boolean;
  onToggleSelected: (id: string, checked: boolean) => void;
}) {
  const entityIndex = useEntityIndex();
  const semanticTags = row.tags.filter((t) => !isProvenanceTag(t));
  const visibleTags = semanticTags.slice(0, VISIBLE_TAG_SLOTS);
  const overflow = row.tags.length - visibleTags.length;
  const displayName = formatMemoryDisplayName(row.name, row.tags);

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
      data-testid="memories-row"
      className="flex items-center gap-3 py-1.5 border-b border-border/50 last:border-0 cursor-pointer hover:bg-muted/30 transition-colors rounded-sm"
    >
      <Checkbox
        checked={selected}
        onCheckedChange={(v) => onToggleSelected(row.id, v === true)}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Select ${row.name}`}
        className="flex-shrink-0"
      />
      <span className="w-16 flex-shrink-0 font-mono text-small text-foreground">
        {row.shortId ?? "—"}
      </span>
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <TypeBadge type={row.type} />
        <div className="min-w-0 flex-1">
          <div className="text-body truncate" title={row.name}>
            {displayName}
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
        data-col="created"
        className="w-24 flex-shrink-0 text-right tabular-nums text-small text-muted-foreground"
        title={absoluteIso(row.createdAt)}
      >
        {relativeTime(row.createdAt)}
      </span>
      <div
        data-col="tags"
        className={cn(
          TAGS_COLUMN_WIDTH_CLASS,
          "hidden lg:flex flex-wrap content-center justify-end gap-0.5 overflow-hidden"
        )}
      >
        {visibleTags.map((tag) => (
          <button
            key={tag}
            type="button"
            title={tag}
            aria-label={`Filter by ${tag}`}
            onClick={(e) => {
              e.stopPropagation();
              onTagClick(tag);
            }}
            className="max-w-[64px] truncate px-1 py-0.5 rounded bg-muted text-muted-foreground text-[10px] whitespace-nowrap hover:bg-primary/20 hover:text-primary transition-colors"
          >
            {tag}
          </button>
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

  // Bulk-selection state (mt#4766) — a plain Set, not folded into URL state:
  // selection is a working-set for an in-progress bulk action, not a durable
  // view the operator would want to bookmark or share (unlike every other
  // piece of state on this page, which round-trips through the URL).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

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
      urlState.filters.tags,
      urlState.filters.since,
      urlState.filters.unreadOrCold,
      // The legacy alias reaches buildListParams too, so it belongs here for
      // the same reason the comment below gives (mt#4799).
      urlState.filters.stale,
      // mt#4767: every filter that reaches buildListParams must appear here,
      // or switching worklists re-serves the previous worklist's cached page
      // under the new heading — a wrong list that looks like a right one.
      urlState.filters.untagged,
      urlState.filters.neverAccessed,
      urlState.filters.cold,
      urlState.filters.coldDays,
      urlState.filters.onlySuperseded,
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
      {selectedIds.size > 0 && (
        <BulkActionsBar
          selectedIds={[...selectedIds]}
          onClear={() => setSelectedIds(new Set())}
        />
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
            allOnPageSelected={
              controls.pageItems.length > 0 && controls.pageItems.every((r) => selectedIds.has(r.id))
            }
            onToggleAll={(checked) => {
              setSelectedIds((prev) => {
                const next = new Set(prev);
                for (const row of controls.pageItems) {
                  if (checked) next.add(row.id);
                  else next.delete(row.id);
                }
                return next;
              });
            }}
          />
          {controls.pageItems.map((row) => (
            <MemoriesRowItem
              key={row.id}
              row={row}
              onRowClick={onRowClick}
              onTagClick={(tag) => controls.setFilter("tags", tag)}
              selected={selectedIds.has(row.id)}
              onToggleSelected={toggleSelected}
            />
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

/**
 * Memories curation-worklist widget backend (mt#4767).
 *
 * Replaces `memories-stats`' five vanity numbers (a total, a type breakdown,
 * a 7-day count, a superseded count, a top-3-accessed list) with populations
 * an operator can ACT on: how many records carry no tags, how many have never
 * been read, how many were read once and not since, how many are byte-identical
 * duplicates of another record, and how many are superseded. Each is a count
 * whose click lands on that population, so the numbers are queue heads rather
 * than trivia.
 *
 * NOT named `memories-health` (mt#4767 success criterion): that widget already
 * exists and means EMBEDDINGS-PROVIDER health (mt#2373) — provider status,
 * fallback state, error counts — and renders in this same page's header. Two
 * different senses of "health" on one page is the naming collision this task
 * exists partly to stop repeating; see the `stale`/`cold` split below for the
 * one it inherited.
 *
 * DELIBERATELY DOES NOT GO THROUGH `MemoryService`, following
 * `memories-facets.ts` (mt#4763): these are aggregates with no row output, and
 * `MemoryServiceSurface` has no equivalent for a `count(*) filter (...)` fan or
 * a content-hash `GROUP BY`. Takes a raw handle via `createCachedSqlDbGetter`
 * from `db-providers.ts` — the same "widget needs SQL, not a service" seam
 * `getContextInspectorDb` / `getServerEngprodDb` / the facets widget already
 * use. No change to `memory-service.ts` was needed FOR THE COUNTS.
 *
 * The click-through FILTERS are a different matter and DID need the domain
 * layer: a worklist link lands on `MemoriesList`, which renders through
 * `memories-list` -> `MemoryService.list()` -> `MemoryListFilter`, so
 * `untagged` / `neverAccessed` / `cold` / `onlySuperseded` were added there
 * (mt#4767). The two paths build the same predicates from the same columns
 * independently; `scripts/verify-memory-worklists.ts` asserts they agree
 * against the live corpus, which is this task's AT1 evidence.
 *
 * ---------------------------------------------------------------------------
 * Why "cold" and not "stale"
 * ---------------------------------------------------------------------------
 * `MemoryListFilter.stale` is `last_accessed_at IS NULL OR older than N` — a
 * UNION that SUBSUMES never-read. Specced as two worklists it would have
 * shipped the same list twice: measured 2026-08-31, `stale` at its 90-day
 * default returns 252 rows against never-read's 251, because exactly one
 * record in the corpus has been read but not within 90 days (the corpus has
 * only tracked `last_accessed_at` since 2026-05-27). So this widget counts
 * `neverRead` and `cold` as a PARTITION — cold requires `last_accessed_at IS
 * NOT NULL` — and never touches `stale`.
 *
 * The word matters too: `staleness.ts` emits `⚠️ POSSIBLY OBSOLETE` for a
 * memory whose TRACKING TASK shipped, an unrelated property. mt#4763 shipped a
 * cohort chip labelled "Stale" in the last-accessed sense; mt#4767 relabels it
 * "Cold". Renaming the domain field itself is a tracked follow-up.
 *
 * ---------------------------------------------------------------------------
 * Duplicates are SURFACED here and acted on nowhere (mt#4767 / mt#1619)
 * ---------------------------------------------------------------------------
 * This widget reports the duplicate population and the frontend renders it
 * read-only. mt#1619 owns the dedup KEY DECISION and the cleanup, and the two
 * keys disagree by design: mt#1619 measured 63 redundant rows keyed on
 * `(name, md5(content))` within the `imported-from:claude-code` batch, while
 * this widget's content-only `md5(content)` key finds 204 across 116 groups
 * corpus-wide — a content-only key also catches renamed copies. That
 * difference is information mt#1619 needs, not a discrepancy to reconcile
 * here. Nothing in this file mutates anything.
 */
import { eq, inArray, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { createCachedSqlDbGetter, describeWidgetDegradedReason } from "../db-providers";
import {
  memoriesTable,
  PROJECT_AGNOSTIC_MEMORY_SCOPES,
} from "@minsky/domain/storage/schemas/memory-embeddings";
import { DEFAULT_COLD_DAYS } from "@minsky/domain/memory/types";
import { isAllProjects, type ProjectScope } from "@minsky/domain/project/scope";
import type { MemoryType, MemoryScope } from "@minsky/domain/memory/types";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------

/** One curation worklist: a population, its size, and how to reach it. */
export interface CurationWorklist {
  /** Stable key the frontend maps to a URL filter — never a display string. */
  id: "untagged" | "neverRead" | "cold" | "duplicates" | "superseded";
  count: number;
}

/** One week of the growth panel, cohort-split. */
export interface GrowthBucket {
  /** ISO date of the week's Monday (UTC), "YYYY-MM-DD". */
  weekStart: string;
  total: number;
  handoff: number;
  retrospective: number;
  /** total - handoff - retrospective. A record tagged BOTH counts once in
   * each of those two and is excluded from `other`, so the three sum to
   * `total` only when no record carries both tags; `total` is authoritative. */
  other: number;
}

export interface MemoriesCurationPayload {
  worklists: CurationWorklist[];
  /** Distinct content-hash groups with more than one member (mt#1619 links
   * out from here). `duplicates.count` above is the REDUNDANT row count —
   * `sum(n-1)` — which is what a cleanup would remove; this is how many
   * distinct texts those rows collapse into. */
  duplicateGroups: number;
  /** The threshold `cold` was computed at, so the UI never has to guess. */
  coldDays: number;
  /** Oldest 8 weeks first. */
  growth: GrowthBucket[];
}

/** How many weeks the growth panel covers (mt#4767 success criterion). */
export const GROWTH_WEEKS = 8;

interface CurationFilter {
  type?: MemoryType;
  scope?: MemoryScope;
  projectScope?: ProjectScope;
  coldDays: number;
}

// ---------------------------------------------------------------------------
// WHERE-condition builder — a curation-scoped subset of memory-service.ts's
// `buildListConditions` (not exported there, and this widget must not modify
// it — see module docblock). Mirrors `memories-facets.ts`'s
// `buildFacetConditions`.
//
// `excludeSuperseded` is deliberately ABSENT: the superseded worklist counts
// superseded rows, so a scope that excluded them would zero its own headline
// number. The duplicate query applies `superseded_by IS NULL` itself, since a
// superseded copy is not a redundant row — it is already resolved.
// ---------------------------------------------------------------------------

function scopedToProject(projectScope: string) {
  return or(
    eq(memoriesTable.projectId, projectScope),
    inArray(memoriesTable.scope, PROJECT_AGNOSTIC_MEMORY_SCOPES)
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildCurationConditions(filter: CurationFilter): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conditions: any[] = [];
  if (filter.type) conditions.push(eq(memoriesTable.type, filter.type));
  if (filter.scope) conditions.push(eq(memoriesTable.scope, filter.scope));
  if (filter.projectScope && !isAllProjects(filter.projectScope)) {
    conditions.push(scopedToProject(filter.projectScope));
  }
  return conditions;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

interface CountsRow {
  untagged: number;
  never_read: number;
  cold: number;
  superseded: number;
  duplicate_rows: number;
  duplicate_groups: number;
}

/**
 * All five worklist counts in ONE round trip.
 *
 * The four scalar populations are `count(*) filter (...)` over the scoped set;
 * the two duplicate figures are correlated sub-selects over the SAME scope, so
 * a project filter narrows them too rather than leaving a global number beside
 * four scoped ones (the mt#4763 facets criterion, applied here).
 *
 * `cold` uses an interval computed in SQL rather than a JS timestamp — this
 * query has no reason to care what the app server's clock says, and
 * `now() - interval` keeps the boundary in the same place the row data lives.
 * `buildListConditions`' matching `cold` filter DOES take an injected clock,
 * because it is the one a unit test needs to pin.
 */
async function queryCounts(db: PostgresJsDatabase, filter: CurationFilter): Promise<CountsRow> {
  const conditions = buildCurationConditions(filter);
  const whereClause =
    conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
  const scopedWhere = conditions.length > 0 ? sql`AND ${sql.join(conditions, sql` AND `)}` : sql``;
  const coldInterval = sql.raw(`interval '${filter.coldDays} days'`);

  const result = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE cardinality(${memoriesTable.tags}) = 0)::int AS untagged,
      count(*) FILTER (WHERE ${memoriesTable.lastAccessedAt} IS NULL)::int AS never_read,
      count(*) FILTER (
        WHERE ${memoriesTable.lastAccessedAt} IS NOT NULL
          AND ${memoriesTable.lastAccessedAt} < now() - ${coldInterval}
      )::int AS cold,
      count(*) FILTER (WHERE ${memoriesTable.supersededBy} IS NOT NULL)::int AS superseded,
      (
        SELECT coalesce(sum(n - 1), 0)::int FROM (
          SELECT count(*) AS n FROM ${memoriesTable}
          WHERE ${memoriesTable.supersededBy} IS NULL ${scopedWhere}
          GROUP BY md5(${memoriesTable.content}) HAVING count(*) > 1
        ) g
      ) AS duplicate_rows,
      (
        SELECT count(*)::int FROM (
          SELECT 1 FROM ${memoriesTable}
          WHERE ${memoriesTable.supersededBy} IS NULL ${scopedWhere}
          GROUP BY md5(${memoriesTable.content}) HAVING count(*) > 1
        ) g
      ) AS duplicate_groups
    FROM ${memoriesTable}
    ${whereClause}
  `);

  const rows = Array.from(result as Iterable<CountsRow>);
  const row = rows[0];
  return {
    untagged: Number(row?.untagged ?? 0),
    never_read: Number(row?.never_read ?? 0),
    cold: Number(row?.cold ?? 0),
    superseded: Number(row?.superseded ?? 0),
    duplicate_rows: Number(row?.duplicate_rows ?? 0),
    duplicate_groups: Number(row?.duplicate_groups ?? 0),
  };
}

interface GrowthRow {
  week_start: string;
  total: number;
  handoff: number;
  retrospective: number;
}

/**
 * Creations per ISO week for the last {@link GROWTH_WEEKS} weeks, split by the
 * two cohorts that actually drive the corpus's growth.
 *
 * The handoff share is the number this panel exists for: measured 2026-08-31,
 * August's 546 new records included 290 handoffs — 53%. `date_trunc('week')`
 * is ISO (Monday-start), so a bucket is comparable week to week.
 */
async function queryGrowth(
  db: PostgresJsDatabase,
  filter: CurationFilter
): Promise<GrowthBucket[]> {
  const conditions = buildCurationConditions(filter);
  const scopedWhere = conditions.length > 0 ? sql`AND ${sql.join(conditions, sql` AND `)}` : sql``;
  const window = sql.raw(`interval '${GROWTH_WEEKS} weeks'`);

  const result = await db.execute(sql`
    SELECT
      to_char(date_trunc('week', ${memoriesTable.createdAt}), 'YYYY-MM-DD') AS week_start,
      count(*)::int AS total,
      count(*) FILTER (WHERE 'handoff' = ANY(${memoriesTable.tags}))::int AS handoff,
      count(*) FILTER (WHERE 'retrospective' = ANY(${memoriesTable.tags}))::int AS retrospective
    FROM ${memoriesTable}
    WHERE ${memoriesTable.createdAt} >= date_trunc('week', now() - ${window})
    ${scopedWhere}
    GROUP BY 1
    ORDER BY 1 ASC
  `);

  return Array.from(result as Iterable<GrowthRow>).map((r) => {
    const total = Number(r.total);
    const handoff = Number(r.handoff);
    const retrospective = Number(r.retrospective);
    return {
      weekStart: r.week_start,
      total,
      handoff,
      retrospective,
      other: Math.max(0, total - handoff - retrospective),
    };
  });
}

// ---------------------------------------------------------------------------
// Pure assembly — the testable core (functional-core / imperative-shell,
// testing-standards.mdc). No DB, no clock: takes the two query results and
// shapes the payload.
// ---------------------------------------------------------------------------

export function assembleCurationPayload(
  counts: CountsRow,
  growth: GrowthBucket[],
  coldDays: number
): MemoriesCurationPayload {
  return {
    worklists: [
      { id: "untagged", count: counts.untagged },
      { id: "neverRead", count: counts.never_read },
      { id: "cold", count: counts.cold },
      { id: "duplicates", count: counts.duplicate_rows },
      { id: "superseded", count: counts.superseded },
    ],
    duplicateGroups: counts.duplicate_groups,
    coldDays,
    growth,
  };
}

// ---------------------------------------------------------------------------
// Widget module
// ---------------------------------------------------------------------------

/**
 * Parse a positive-integer query param, falling back to `fallback`.
 *
 * Rejects zero, negatives and non-numerics rather than passing them into the
 * SQL interval: `interval '0 days'` would silently make every read record
 * "cold", which is a wrong ANSWER rather than an error — exactly the shape
 * that survives review. `sql.raw` is used for the interval, so this is also
 * the injection boundary; only a validated integer reaches it.
 */
export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Factory: returns a WidgetModule backed by the given raw-db getter.
 * Mirrors `createMemoriesFacetsWidget`'s test-seam shape (mt#4763/mt#4727).
 */
export function createMemoriesCurationWidget(
  getDb: () => Promise<PostgresJsDatabase | null>,
  getProjectScopeDb?: () => Promise<ScopeResolverDb | null>
): WidgetModule {
  return {
    id: "memories-curation",
    title: "Memories — Curation",
    updateMode: { type: "polling", intervalMs: 60_000 },
    async fetch(ctx: WidgetContext): Promise<WidgetData> {
      try {
        const db = await getDb();
        if (!db) {
          return {
            state: "degraded",
            reason: "Memory service unavailable — DB not connected",
          };
        }

        const { query } = ctx;
        const { resolveCockpitProjectScope } = await import("../project-scope");
        const projectScope = await resolveCockpitProjectScope(query?.project, {
          getDb: getProjectScopeDb,
        });

        const coldDays = parsePositiveInt(query?.coldDays, DEFAULT_COLD_DAYS);
        const filter: CurationFilter = {
          type: query?.type as MemoryType | undefined,
          scope: query?.scope as MemoryScope | undefined,
          projectScope,
          coldDays,
        };

        const [counts, growth] = await Promise.all([
          queryCounts(db, filter),
          queryGrowth(db, filter),
        ]);

        return { state: "ok", payload: assembleCurationPayload(counts, growth, coldDays) };
      } catch (err) {
        return {
          state: "degraded",
          reason: describeWidgetDegradedReason("memories curation", err),
        };
      }
    },
  };
}

/** Default production widget — the cockpit-wide cached SQL db getter. */
const getCurationDb = createCachedSqlDbGetter({ cacheNegative: false });
export const memoriesCurationWidget: WidgetModule = createMemoriesCurationWidget(getCurationDb);

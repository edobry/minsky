/**
 * Memories facet-rail widget backend (mt#4763).
 *
 * Serves tag counts for the `/memories` facet rail from ONE `unnest(tags) +
 * GROUP BY` query, so the rail's counts are always live and always respect
 * the active project scope AND the other active filters (type/scope/
 * excludeSuperseded) — the mt#4763 success criterion that counts must
 * NARROW as filters apply, never stay global. mt#4763's Context section
 * warns that the tag vocabulary lives in the DATA, not in any write-site
 * grep — this widget doesn't hardcode a tag list at all; it counts whatever
 * is actually in the corpus.
 *
 * Deliberately does NOT go through `MemoryService` (unlike memories-list.ts
 * / memories-stats.ts): a per-tag GROUP BY has no equivalent in
 * `MemoryServiceSurface`, and adding one there is out of this task's scope
 * (the file-scope note for mt#4763 lists only cockpit widget/page files).
 * Uses the same `createCachedSqlDbGetter` factory `db-providers.ts` already
 * exports for exactly this "widget needs a raw SQL handle, not a service"
 * shape (see `getContextInspectorDb`/`getServerEngprodDb` for the existing
 * callers) — no changes to that module were needed.
 *
 * Namespace grouping happens in application code AFTER the single query
 * returns, not via a second query: `family:`, `imported-from:`,
 * `content-hash:`, `theme:`, `tracking:` and any other `<ns>:<value>` tag
 * are grouped under their namespace; everything else is "flat". The
 * provenance namespaces (`imported-from`, `content-hash`) are named here so
 * the frontend can collapse them by default without re-deriving the list —
 * they are 697 of the tag occurrences and none of the meaning (mt#4763
 * Summary).
 *
 * Facet counts are DELIBERATELY not conditioned on the currently-selected
 * `tags` filter itself (only on type/scope/excludeSuperseded/nameContains) —
 * standard faceted-search practice: conditioning a dimension's own counts on
 * its own current selection would hide every tag not already selected,
 * defeating the point of a multi-select rail. AT3 (mt#4763) only exercises
 * type-filter conditioning, which this satisfies.
 */
import { eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { createCachedSqlDbGetter } from "../db-providers";
import { describeWidgetDegradedReason } from "../db-providers";
import {
  memoriesTable,
  PROJECT_AGNOSTIC_MEMORY_SCOPES,
} from "@minsky/domain/storage/schemas/memory-embeddings";
import { escapeLikePattern } from "@minsky/domain/memory/intervening-task-lookup";
import { isAllProjects, type ProjectScope } from "@minsky/domain/project/scope";
import type { MemoryType, MemoryScope } from "@minsky/domain/memory/types";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------

export interface TagFacet {
  tag: string;
  count: number;
}

export interface NamespaceFacetGroup {
  namespace: string;
  tags: TagFacet[];
  totalCount: number;
}

export interface MemoriesFacetsPayload {
  /** Non-namespaced tags (no `:`), sorted by count descending. */
  flat: TagFacet[];
  /** `<namespace>:<value>` tags grouped by namespace, sorted by total count descending. */
  namespaces: NamespaceFacetGroup[];
}

/** Machine-provenance namespaces the frontend collapses by default (mt#4763). */
export const PROVENANCE_TAG_NAMESPACES = ["imported-from", "content-hash"] as const;

interface FacetsFilter {
  type?: MemoryType;
  scope?: MemoryScope;
  excludeSuperseded?: boolean;
  nameContains?: string;
  projectScope?: ProjectScope;
}

// ---------------------------------------------------------------------------
// WHERE-condition builder — a facets-scoped subset of memory-service.ts's
// `buildListConditions` (that function is not exported and this widget must
// not modify memory-service.ts — see module docblock). Only the filters the
// `/memories` toolbar actually exposes are included; `tags` is deliberately
// excluded per the module docblock above.
// ---------------------------------------------------------------------------

function scopedToProject(projectScope: string) {
  return or(
    eq(memoriesTable.projectId, projectScope),
    inArray(memoriesTable.scope, PROJECT_AGNOSTIC_MEMORY_SCOPES)
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildFacetConditions(filter: FacetsFilter): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conditions: any[] = [];
  if (filter.type) conditions.push(eq(memoriesTable.type, filter.type));
  if (filter.scope) conditions.push(eq(memoriesTable.scope, filter.scope));
  if (filter.projectScope && !isAllProjects(filter.projectScope)) {
    conditions.push(scopedToProject(filter.projectScope));
  }
  if (filter.excludeSuperseded) conditions.push(isNull(memoriesTable.supersededBy));
  if (filter.nameContains) {
    conditions.push(ilike(memoriesTable.name, `%${escapeLikePattern(filter.nameContains)}%`));
  }
  return conditions;
}

/**
 * The single unnest+GROUP BY query this widget exists to run (mt#4763
 * success criterion). Returns every distinct tag with its count, sorted
 * descending — grouping into flat/namespaced happens in `groupFacetRows`
 * below, in application code, so this stays exactly one round trip.
 */
async function queryTagCounts(db: PostgresJsDatabase, filter: FacetsFilter): Promise<TagFacet[]> {
  const conditions = buildFacetConditions(filter);
  const whereClause =
    conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

  const result = await db.execute(sql`
    SELECT tag, COUNT(*)::int AS count
    FROM ${memoriesTable}, unnest(${memoriesTable.tags}) AS tag
    ${whereClause}
    GROUP BY tag
    ORDER BY count DESC, tag ASC
  `);

  return Array.from(result as Iterable<{ tag: string; count: number }>).map((r) => ({
    tag: r.tag,
    count: Number(r.count),
  }));
}

// ---------------------------------------------------------------------------
// Pure grouping function — the testable core (functional-core / imperative-
// shell split, testing-standards.mdc). No DB, no I/O: takes the flat rows
// the single query above returns and buckets them by namespace.
// ---------------------------------------------------------------------------

function namespaceOf(tag: string): string | null {
  const idx = tag.indexOf(":");
  return idx === -1 ? null : tag.slice(0, idx).toLowerCase();
}

export function groupFacetRows(rows: TagFacet[]): MemoriesFacetsPayload {
  const flat: TagFacet[] = [];
  const byNamespace = new Map<string, TagFacet[]>();

  for (const row of rows) {
    const ns = namespaceOf(row.tag);
    if (ns === null) {
      flat.push(row);
      continue;
    }
    const bucket = byNamespace.get(ns);
    if (bucket) {
      bucket.push(row);
    } else {
      byNamespace.set(ns, [row]);
    }
  }

  const namespaces: NamespaceFacetGroup[] = Array.from(byNamespace.entries())
    .map(([namespace, tags]) => ({
      namespace,
      // Rows already arrive count-desc from SQL; re-sort defensively so this
      // function's contract doesn't depend on caller ordering.
      tags: [...tags].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
      totalCount: tags.reduce((sum, t) => sum + t.count, 0),
    }))
    .sort((a, b) => b.totalCount - a.totalCount || a.namespace.localeCompare(b.namespace));

  return {
    flat: [...flat].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    namespaces,
  };
}

// ---------------------------------------------------------------------------
// Widget module
// ---------------------------------------------------------------------------

function parseBool(value: string | undefined): boolean {
  return value === "true";
}

/**
 * Factory: returns a WidgetModule backed by the given raw-db getter.
 * Mirrors `memories-list.ts`'s `createMemoriesListWidget` test-seam pattern
 * (mt#4727), but injects a `PostgresJsDatabase | null` getter directly since
 * this widget has no `MemoryServiceSurface` dependency at all.
 */
export function createMemoriesFacetsWidget(
  getDb: () => Promise<PostgresJsDatabase | null>,
  getProjectScopeDb?: () => Promise<ScopeResolverDb | null>
): WidgetModule {
  return {
    id: "memories-facets",
    title: "Memories — Tag Facets",
    updateMode: { type: "polling", intervalMs: 30_000 },
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

        const filter: FacetsFilter = {
          type: query?.type as MemoryType | undefined,
          scope: query?.scope as MemoryScope | undefined,
          excludeSuperseded: parseBool(query?.excludeSuperseded),
          nameContains: query?.nameContains,
          projectScope,
        };

        const rows = await queryTagCounts(db, filter);
        const payload = groupFacetRows(rows);

        return { state: "ok", payload };
      } catch (err) {
        return { state: "degraded", reason: describeWidgetDegradedReason("memories facets", err) };
      }
    },
  };
}

/** Default production widget — the cockpit-wide cached SQL db getter. */
const getFacetsDb = createCachedSqlDbGetter({ cacheNegative: false });
export const memoriesFacetsWidget: WidgetModule = createMemoriesFacetsWidget(getFacetsDb);

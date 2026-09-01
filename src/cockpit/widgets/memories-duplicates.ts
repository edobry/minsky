/**
 * Memories duplicate-groups widget backend (mt#4767).
 *
 * Serves the `mem_view=duplicates` page view: records that are byte-identical
 * to at least one other record, grouped by content hash.
 *
 * ---------------------------------------------------------------------------
 * Why a VIEW and not a table filter
 * ---------------------------------------------------------------------------
 * The other four curation worklists are row predicates, so they land on the
 * ordinary `MemoriesList` with a `mem_f_*` filter in the URL (mt#4767 AT2).
 * "Grouped by content hash" is not a row predicate: filtering the flat table
 * to rows-that-have-a-twin discards the very grouping that makes the
 * population readable — you get 204 rows in created-desc order with no
 * indication of which is a copy of which.
 *
 * mt#4763 already solved this exact shape for families, with a page-level
 * `mem_view=families` toggle that REPLACES the table rather than filtering it
 * (`MemoriesPage.tsx`: "a families rollup is not a filtered slice of the same
 * table"). A duplicate rollup is the same kind of object, so it reuses that
 * mechanism instead of introducing a third way to express a page view.
 *
 * ---------------------------------------------------------------------------
 * Read-only, and structurally so (mt#4767 AT4 / mt#1619)
 * ---------------------------------------------------------------------------
 * This widget SURFACES; mt#1619 decides and cleans. It runs no mutation and
 * its payload deliberately carries no affordance for one — no supersede
 * target, no "canonical" nomination, no ranking that implies which copy to
 * keep. Picking the survivor requires the dedup KEY DECISION mt#1619 owns, and
 * a UI that quietly implied an answer would preempt it.
 *
 * The key here is `md5(content)` ALONE, deliberately differing from mt#1619's
 * `(name, md5(content))`: a content-only key also catches renamed copies. The
 * two therefore report different populations (204 rows / 116 groups corpus-wide
 * here, against mt#1619's 63 within the `imported-from:claude-code` batch), and
 * that difference is an input mt#1619 wants — not a discrepancy to reconcile in
 * this file.
 *
 * Superseded rows are excluded: a record already superseded is a resolved
 * duplicate, not an outstanding one.
 */
import { eq, inArray, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { createCachedSqlDbGetter, describeWidgetDegradedReason } from "../db-providers";
import {
  memoriesTable,
  PROJECT_AGNOSTIC_MEMORY_SCOPES,
} from "@minsky/domain/storage/schemas/memory-embeddings";
import { isAllProjects, type ProjectScope } from "@minsky/domain/project/scope";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------

/** One member of a duplicate group. Ordered oldest-first by the query. */
export interface DuplicateMember {
  id: string;
  shortId: string | null;
  name: string;
  type: string;
  createdAt: string;
  /** Null when never read — rendered as such, never as 0 (mt#4767). */
  lastAccessedAt: string | null;
  accessCount: number;
}

export interface DuplicateGroup {
  /** `md5(content)` — the grouping key, surfaced so the UI has a stable id. */
  contentHash: string;
  /** How many records share this exact content. Always >= 2. */
  memberCount: number;
  /** First ~120 chars of the shared content, for recognizing the group. */
  preview: string;
  members: DuplicateMember[];
}

export interface MemoriesDuplicatesPayload {
  groups: DuplicateGroup[];
  /** Total groups matching, which may exceed `groups.length` — see `limit`. */
  totalGroups: number;
  /** Redundant rows: `sum(memberCount - 1)` across ALL matching groups, not
   * just the rendered page. This is what a cleanup would remove. */
  totalRedundantRows: number;
  /** How many groups this payload actually carries. */
  limit: number;
}

/**
 * Groups per response. The corpus has 116 (measured 2026-08-31); this bounds
 * a pathological case without paginating a read-only surface nobody acts on
 * from. `totalGroups` always reports the true count, so a truncated render can
 * never read as "that's all of them" (mt#2817's loud-caps discipline).
 */
export const DUPLICATE_GROUP_LIMIT = 200;

/** Members rendered per group. Groups are near-always 2; this bounds the tail. */
const MEMBERS_PER_GROUP = 25;

const PREVIEW_CHARS = 120;

interface DuplicatesFilter {
  projectScope?: ProjectScope;
}

function scopedToProject(projectScope: string) {
  return or(
    eq(memoriesTable.projectId, projectScope),
    inArray(memoriesTable.scope, PROJECT_AGNOSTIC_MEMORY_SCOPES)
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildDuplicateConditions(filter: DuplicatesFilter): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conditions: any[] = [];
  if (filter.projectScope && !isAllProjects(filter.projectScope)) {
    conditions.push(scopedToProject(filter.projectScope));
  }
  return conditions;
}

interface DuplicateRow {
  content_hash: string;
  member_count: number;
  preview: string;
  id: string;
  short_id: string | null;
  name: string;
  type: string;
  created_at: string;
  last_accessed_at: string | null;
  access_count: number;
}

/**
 * One query returning every member of every duplicate group, pre-joined to its
 * group's aggregate columns.
 *
 * A window function does the grouping (`count(*) OVER (PARTITION BY hash)`)
 * rather than a self-join or a second round trip: the aggregate and the member
 * rows come back together, and `groupDuplicateRows` below folds them in
 * application code. Rows arrive group-ordered so that fold is a single pass.
 */
async function queryDuplicateRows(
  db: PostgresJsDatabase,
  filter: DuplicatesFilter
): Promise<DuplicateRow[]> {
  const conditions = buildDuplicateConditions(filter);
  const scopedWhere = conditions.length > 0 ? sql`AND ${sql.join(conditions, sql` AND `)}` : sql``;

  const result = await db.execute(sql`
    WITH scoped AS (
      SELECT
        md5(${memoriesTable.content}) AS content_hash,
        ${memoriesTable.id} AS id,
        ${memoriesTable.shortId} AS short_id,
        ${memoriesTable.name} AS name,
        ${memoriesTable.type} AS type,
        ${memoriesTable.createdAt} AS created_at,
        ${memoriesTable.lastAccessedAt} AS last_accessed_at,
        ${memoriesTable.accessCount} AS access_count,
        left(${memoriesTable.content}, ${PREVIEW_CHARS}) AS preview
      FROM ${memoriesTable}
      WHERE ${memoriesTable.supersededBy} IS NULL ${scopedWhere}
    ), grouped AS (
      SELECT *, count(*) OVER (PARTITION BY content_hash) AS member_count
      FROM scoped
    ), dup_groups AS (
      SELECT DISTINCT content_hash FROM grouped WHERE member_count > 1
      ORDER BY content_hash
      LIMIT ${DUPLICATE_GROUP_LIMIT}
    )
    SELECT g.* FROM grouped g
    JOIN dup_groups d ON d.content_hash = g.content_hash
    ORDER BY g.content_hash ASC, g.created_at ASC
  `);

  return Array.from(result as Iterable<DuplicateRow>);
}

interface TotalsRow {
  total_groups: number;
  total_redundant_rows: number;
}

/** Group and redundant-row totals across ALL matching groups, unbounded by
 * {@link DUPLICATE_GROUP_LIMIT} — so a truncated render still reports the
 * true size of the population. */
async function queryTotals(db: PostgresJsDatabase, filter: DuplicatesFilter): Promise<TotalsRow> {
  const conditions = buildDuplicateConditions(filter);
  const scopedWhere = conditions.length > 0 ? sql`AND ${sql.join(conditions, sql` AND `)}` : sql``;

  const result = await db.execute(sql`
    SELECT
      count(*)::int AS total_groups,
      coalesce(sum(n - 1), 0)::int AS total_redundant_rows
    FROM (
      SELECT count(*) AS n FROM ${memoriesTable}
      WHERE ${memoriesTable.supersededBy} IS NULL ${scopedWhere}
      GROUP BY md5(${memoriesTable.content}) HAVING count(*) > 1
    ) g
  `);

  const row = Array.from(result as Iterable<TotalsRow>)[0];
  return {
    total_groups: Number(row?.total_groups ?? 0),
    total_redundant_rows: Number(row?.total_redundant_rows ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Pure fold — the testable core (functional-core / imperative-shell).
// ---------------------------------------------------------------------------

function toIso(value: string | Date | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export function groupDuplicateRows(rows: DuplicateRow[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  let current: DuplicateGroup | null = null;

  for (const row of rows) {
    if (!current || current.contentHash !== row.content_hash) {
      current = {
        contentHash: row.content_hash,
        memberCount: Number(row.member_count),
        preview: row.preview ?? "",
        members: [],
      };
      groups.push(current);
    }
    if (current.members.length < MEMBERS_PER_GROUP) {
      current.members.push({
        id: row.id,
        shortId: row.short_id,
        name: row.name,
        type: row.type,
        createdAt: toIso(row.created_at) ?? "",
        lastAccessedAt: toIso(row.last_accessed_at),
        accessCount: Number(row.access_count ?? 0),
      });
    }
  }

  // Largest groups first — the ones a cleanup would want to look at.
  return groups.sort(
    (a, b) => b.memberCount - a.memberCount || a.contentHash.localeCompare(b.contentHash)
  );
}

// ---------------------------------------------------------------------------
// Widget module
// ---------------------------------------------------------------------------

export function createMemoriesDuplicatesWidget(
  getDb: () => Promise<PostgresJsDatabase | null>,
  getProjectScopeDb?: () => Promise<ScopeResolverDb | null>
): WidgetModule {
  return {
    id: "memories-duplicates",
    title: "Memories — Duplicates",
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

        const { resolveCockpitProjectScope } = await import("../project-scope");
        const projectScope = await resolveCockpitProjectScope(ctx.query?.project, {
          getDb: getProjectScopeDb,
        });
        const filter: DuplicatesFilter = { projectScope };

        const [rows, totals] = await Promise.all([
          queryDuplicateRows(db, filter),
          queryTotals(db, filter),
        ]);

        const payload: MemoriesDuplicatesPayload = {
          groups: groupDuplicateRows(rows),
          totalGroups: totals.total_groups,
          totalRedundantRows: totals.total_redundant_rows,
          limit: DUPLICATE_GROUP_LIMIT,
        };
        return { state: "ok", payload };
      } catch (err) {
        return {
          state: "degraded",
          reason: describeWidgetDegradedReason("memories duplicates", err),
        };
      }
    },
  };
}

/** Default production widget — the cockpit-wide cached SQL db getter. */
const getDuplicatesDb = createCachedSqlDbGetter({ cacheNegative: false });
export const memoriesDuplicatesWidget: WidgetModule =
  createMemoriesDuplicatesWidget(getDuplicatesDb);

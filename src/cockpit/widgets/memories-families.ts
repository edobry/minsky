/**
 * Memories "families" view widget backend (mt#4763).
 *
 * A `family:<slug>` tag on a memory marks it as a member of a recurring-
 * failure family (the `/retrospective` prose convention — no code writes
 * these tags, 151 memories across 38 distinct families carry them by hand;
 * see mt#4763's `## Context` for why a write-site grep would miss this
 * entirely). The SAME `family:<slug>` namespace is also used on TASKS
 * (232 of them, per mt#4763's Summary) to mark the structural-fix task a
 * family is tracked against — this widget's whole job is joining those two
 * populations by tag string, since that is the only link between them.
 *
 * Two queries, not one: the memory-side aggregate (member count + first/most
 * recent member date per family) and the task-side membership (which
 * task(s) carry the same `family:<slug>` tag) read different tables with
 * different tag storage shapes — `memories.tags` is a native Postgres
 * `text[]` (`unnest`), `tasks.tags` is a JSON-serialized string stored in a
 * `text` column (`jsonb_array_elements_text`). mt#4763's single-query
 * requirement is scoped to the sibling `memories-facets` widget only (see
 * that module's docblock); this widget has no such constraint.
 *
 * The MEMORY-side aggregate is project-scoped the same way every other
 * `memories-*` widget is (`?project=<slug>`, defaulting to all projects) —
 * matching the mt#4763 spec's own "38 families" / "66 members" measurement,
 * which was taken with no `?project=` filter applied (i.e. the default
 * `ALL_PROJECTS` scope). The TASK-side link query is deliberately left
 * unscoped: it only enriches display (which task a family already links
 * to), not a filter axis, so scoping it would add a `tasksTable.projectId`
 * join for no behavioral change at the one-project reality this corpus is
 * measured against today.
 */
import { eq, inArray, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { createCachedSqlDbGetter } from "../db-providers";
import { describeWidgetDegradedReason } from "../db-providers";
import {
  memoriesTable,
  PROJECT_AGNOSTIC_MEMORY_SCOPES,
} from "@minsky/domain/storage/schemas/memory-embeddings";
import { tasksTable } from "@minsky/domain/storage/schemas/task-embeddings";
import { formatTaskIdForDisplay } from "@minsky/domain/tasks/task-id-utils";
import { isAllProjects, type ProjectScope } from "@minsky/domain/project/scope";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";

/** The namespace this whole widget exists to surface (mt#4763). */
export const FAMILY_TAG_PREFIX = "family:";

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------

export interface FamilyRow {
  /** The tag with its namespace prefix stripped, e.g. "assertion-without-verification". */
  slug: string;
  /** The full tag as stored, e.g. "family:assertion-without-verification". */
  tag: string;
  memberCount: number;
  firstMemberAt: string;
  mostRecentMemberAt: string;
  /** Structural-fix task(s) carrying the same `family:<slug>` tag, display-formatted (e.g. "mt#4749"). */
  structuralFixTasks: string[];
}

export interface MemoriesFamiliesPayload {
  families: FamilyRow[];
}

// ---------------------------------------------------------------------------
// Row shapes as read from SQL, before the pure-function join below.
// ---------------------------------------------------------------------------

export interface FamilyMemoryStatsRow {
  tag: string;
  count: number;
  firstAt: Date | string;
  lastAt: Date | string;
}

export interface FamilyTaskLinkRow {
  tag: string;
  taskId: string;
}

function toIso(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? String(value) : d.toISOString();
}

/**
 * Pure join — the testable core (functional-core / imperative-shell split,
 * testing-standards.mdc). No DB, no I/O: takes the two queries' rows and
 * produces one row per family, sorted by member count descending (so
 * "which family grew this week" — mt#4763's stated use case — is readable
 * without the caller re-sorting).
 */
export function buildFamiliesPayload(
  memoryStats: FamilyMemoryStatsRow[],
  taskLinks: FamilyTaskLinkRow[]
): FamilyRow[] {
  const tasksByTag = new Map<string, Set<string>>();
  for (const link of taskLinks) {
    const set = tasksByTag.get(link.tag) ?? new Set<string>();
    set.add(formatTaskIdForDisplay(link.taskId));
    tasksByTag.set(link.tag, set);
  }

  return memoryStats
    .map((row) => ({
      slug: row.tag.startsWith(FAMILY_TAG_PREFIX)
        ? row.tag.slice(FAMILY_TAG_PREFIX.length)
        : row.tag,
      tag: row.tag,
      memberCount: row.count,
      firstMemberAt: toIso(row.firstAt),
      mostRecentMemberAt: toIso(row.lastAt),
      structuralFixTasks: Array.from(tasksByTag.get(row.tag) ?? []).sort(),
    }))
    .sort((a, b) => b.memberCount - a.memberCount || a.slug.localeCompare(b.slug));
}

// ---------------------------------------------------------------------------
// SQL — two independent reads (see module docblock for why not one).
// ---------------------------------------------------------------------------

/** Mirrors `memories-facets.ts`'s identically-named helper — see that module for rationale. */
function scopedToProject(projectScope: string) {
  return or(
    eq(memoriesTable.projectId, projectScope),
    inArray(memoriesTable.scope, PROJECT_AGNOSTIC_MEMORY_SCOPES)
  );
}

async function queryFamilyMemoryStats(
  db: PostgresJsDatabase,
  projectScope: ProjectScope
): Promise<FamilyMemoryStatsRow[]> {
  const scopeCondition = !isAllProjects(projectScope)
    ? sql`AND ${scopedToProject(projectScope)}`
    : sql``;
  const result = await db.execute(sql`
    SELECT
      tag,
      COUNT(*)::int AS count,
      MIN(${memoriesTable.createdAt}) AS first_at,
      MAX(${memoriesTable.createdAt}) AS last_at
    FROM ${memoriesTable}, unnest(${memoriesTable.tags}) AS tag
    WHERE tag LIKE ${`${FAMILY_TAG_PREFIX}%`}
    ${scopeCondition}
    GROUP BY tag
    ORDER BY count DESC
  `);
  return Array.from(
    result as Iterable<{ tag: string; count: number; first_at: string; last_at: string }>
  ).map((r) => ({ tag: r.tag, count: Number(r.count), firstAt: r.first_at, lastAt: r.last_at }));
}

/**
 * `tasks.tags` is a JSON-serialized `string[]` in a `text` column (not a
 * native Postgres array like `memories.tags`), so membership is read via
 * `jsonb_array_elements_text` rather than `unnest`. `COALESCE(..., '[]')`
 * guards a NULL column; a row whose stored text is not valid JSON would
 * fail the `::jsonb` cast for the whole query (Postgres has no per-row
 * error isolation in a set-returning FROM clause) — acceptable here because
 * every writer of this column goes through `JSON.stringify`, and the
 * widget's outer try/catch degrades gracefully rather than 500ing if this
 * assumption is ever violated.
 */
async function queryFamilyTaskLinks(db: PostgresJsDatabase): Promise<FamilyTaskLinkRow[]> {
  const result = await db.execute(sql`
    SELECT elem AS tag, t.id AS task_id
    FROM ${tasksTable} t, jsonb_array_elements_text(COALESCE(t.tags, '[]')::jsonb) AS elem
    WHERE elem LIKE ${`${FAMILY_TAG_PREFIX}%`}
  `);
  return Array.from(result as Iterable<{ tag: string; task_id: string }>).map((r) => ({
    tag: r.tag,
    taskId: r.task_id,
  }));
}

// ---------------------------------------------------------------------------
// Widget module
// ---------------------------------------------------------------------------

/**
 * Factory: returns a WidgetModule backed by the given raw-db getter.
 * Mirrors `memories-facets.ts`'s test-seam pattern (mt#4763, itself modeled
 * on `memories-list.ts`'s mt#4727 factory convention).
 */
export function createMemoriesFamiliesWidget(
  getDb: () => Promise<PostgresJsDatabase | null>,
  getProjectScopeDb?: () => Promise<ScopeResolverDb | null>
): WidgetModule {
  return {
    id: "memories-families",
    title: "Memories — Families",
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

        const [memoryStats, taskLinks] = await Promise.all([
          queryFamilyMemoryStats(db, projectScope),
          queryFamilyTaskLinks(db),
        ]);

        const payload: MemoriesFamiliesPayload = {
          families: buildFamiliesPayload(memoryStats, taskLinks),
        };

        return { state: "ok", payload };
      } catch (err) {
        return {
          state: "degraded",
          reason: describeWidgetDegradedReason("memories families", err),
        };
      }
    },
  };
}

/** Default production widget — the cockpit-wide cached SQL db getter. */
const getFamiliesDb = createCachedSqlDbGetter({ cacheNegative: false });
export const memoriesFamiliesWidget: WidgetModule = createMemoriesFamiliesWidget(getFamiliesDb);

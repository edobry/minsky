/**
 * Standing pointings — the DB shell over `pointings.ts` (mt#5129).
 *
 * Persists pointing DEFINITIONS (declare / list / archive) and loads the open
 * backlog plus its edges so the pure core can evaluate a query and select a
 * candidate set. Every read here is bulk — one query per table touched — so a
 * candidate set costs a fixed number of round trips regardless of how many
 * tasks the pointing matches (`efficient-database-queries`).
 */

import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { tasksTable, taskSpecsTable } from "../storage/schemas/task-embeddings";
import { taskRelationshipsTable } from "../storage/schemas/task-relationships";
import { pointingsTable, type PointingQuery } from "../storage/schemas/pointings-schema";
import { ALL_PROJECTS, type ProjectScope } from "../project/scope";
import { isTerminal } from "./workflows";
import {
  buildAncestorLookup,
  isEmptyPointingQuery,
  isPointingCandidateRow,
  normalizePointingQuery,
  selectCandidates,
  taskMatchesPointingQuery,
  POINTING_AUTONOMY_CLASSES,
  type CandidateSet,
  type PointingAutonomyClass,
  type PointingTaskRow,
} from "./pointings";

export interface PointingRecord {
  id: string;
  name: string;
  query: PointingQuery;
  autonomyClass: PointingAutonomyClass;
  wipLimit: number;
  projectId: string | null;
  createdAt: Date;
  archivedAt: Date | null;
}

function toRecord(row: typeof pointingsTable.$inferSelect): PointingRecord {
  return {
    id: row.id,
    name: row.name,
    query: row.query,
    autonomyClass: row.autonomyClass as PointingAutonomyClass,
    wipLimit: row.wipLimit,
    projectId: row.projectId,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
  };
}

export type DeclarePointingOutcome =
  | { ok: true; pointing: PointingRecord }
  | {
      ok: false;
      reason: "empty-query" | "invalid-class" | "invalid-wip-limit" | "name-taken";
      message: string;
    };

export async function declarePointing(
  db: PostgresJsDatabase,
  input: {
    name: string;
    query: PointingQuery;
    autonomyClass?: string;
    wipLimit?: number;
    projectScope: ProjectScope;
  }
): Promise<DeclarePointingOutcome> {
  const query = normalizePointingQuery(input.query);
  if (isEmptyPointingQuery(query)) {
    return {
      ok: false,
      reason: "empty-query",
      message: "A pointing needs at least one of tags, parentIds, or taskIds.",
    };
  }
  const autonomyClass = input.autonomyClass ?? "pull-only";
  if (!(POINTING_AUTONOMY_CLASSES as readonly string[]).includes(autonomyClass)) {
    return {
      ok: false,
      reason: "invalid-class",
      message: `autonomyClass must be one of ${POINTING_AUTONOMY_CLASSES.join(", ")}.`,
    };
  }
  const wipLimit = input.wipLimit ?? 1;
  if (!Number.isInteger(wipLimit) || wipLimit < 1) {
    return {
      ok: false,
      reason: "invalid-wip-limit",
      message: "wipLimit must be a positive integer.",
    };
  }
  const projectId = input.projectScope === ALL_PROJECTS ? null : input.projectScope;
  const name = input.name.trim();
  const clash = await db
    .select({ id: pointingsTable.id })
    .from(pointingsTable)
    .where(
      and(
        eq(pointingsTable.name, name),
        isNull(pointingsTable.archivedAt),
        projectId === null
          ? isNull(pointingsTable.projectId)
          : eq(pointingsTable.projectId, projectId)
      )
    )
    .limit(1);
  if (clash.length > 0) {
    return {
      ok: false,
      reason: "name-taken",
      message: `A live pointing named "${name}" already exists.`,
    };
  }
  const [row] = await db
    .insert(pointingsTable)
    .values({ name, query, autonomyClass, wipLimit, projectId })
    .returning();
  if (!row) throw new Error("pointings insert returned no row");
  return { ok: true, pointing: toRecord(row) };
}

export async function listPointings(
  db: PostgresJsDatabase,
  options: { projectScope: ProjectScope; includeArchived?: boolean }
): Promise<PointingRecord[]> {
  const conditions: SQL[] = [];
  if (options.projectScope !== ALL_PROJECTS) {
    conditions.push(eq(pointingsTable.projectId, options.projectScope));
  }
  if (!options.includeArchived) conditions.push(isNull(pointingsTable.archivedAt));
  const rows = await db
    .select()
    .from(pointingsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(pointingsTable.createdAt);
  return rows.map(toRecord);
}

export async function getPointing(
  db: PostgresJsDatabase,
  id: string
): Promise<PointingRecord | null> {
  const [row] = await db.select().from(pointingsTable).where(eq(pointingsTable.id, id)).limit(1);
  return row ? toRecord(row) : null;
}

export type ArchivePointingOutcome =
  | { ok: true; pointing: PointingRecord }
  | { ok: false; reason: "not-found" | "already-archived"; message: string };

export async function archivePointing(
  db: PostgresJsDatabase,
  id: string,
  now: Date = new Date()
): Promise<ArchivePointingOutcome> {
  const existing = await getPointing(db, id);
  if (!existing) return { ok: false, reason: "not-found", message: `No pointing with id ${id}.` };
  if (existing.archivedAt) {
    return {
      ok: false,
      reason: "already-archived",
      message: `Pointing ${id} is already archived.`,
    };
  }
  const [row] = await db
    .update(pointingsTable)
    .set({ archivedAt: now })
    .where(and(eq(pointingsTable.id, id), isNull(pointingsTable.archivedAt)))
    .returning();
  if (!row)
    return {
      ok: false,
      reason: "already-archived",
      message: `Pointing ${id} was archived concurrently.`,
    };
  return { ok: true, pointing: toRecord(row) };
}

// ─── Backlog loading ──────────────────────────────────────────────────────────

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    // intentional-swallow: a malformed tags column reads as untagged; the row still evaluates.
    return [];
  }
}

/** `content` is already the spec's first 4000 chars — the SQL below substrings it. */
function originLineOf(content: string | null): string | null {
  if (!content) return null;
  const m = /^Origin:[^\n]*/m.exec(content);
  return m ? m[0] : null;
}

/** The open, candidate-eligible backlog in scope, with parent edges resolved. */
async function loadCandidateRows(
  db: PostgresJsDatabase,
  projectScope: ProjectScope
): Promise<{ rows: PointingTaskRow[]; ancestorsOf: (id: string) => string[] }> {
  const scopeCondition =
    projectScope === ALL_PROJECTS ? undefined : eq(tasksTable.projectId, projectScope);
  const taskRows = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      status: tasksTable.status,
      kind: tasksTable.kind,
      tags: tasksTable.tags,
      updatedAt: tasksTable.updatedAt,
      origin: sql<string | null>`substring(${taskSpecsTable.content} from 1 for 4000)`,
    })
    .from(tasksTable)
    .leftJoin(taskSpecsTable, eq(taskSpecsTable.taskId, tasksTable.id))
    .where(scopeCondition);

  const parentEdges = await db
    .select({ child: taskRelationshipsTable.fromTaskId, parent: taskRelationshipsTable.toTaskId })
    .from(taskRelationshipsTable)
    .where(eq(taskRelationshipsTable.type, "parent"));
  const parentOf = new Map<string, string>();
  for (const e of parentEdges) parentOf.set(e.child, e.parent);

  const rows: PointingTaskRow[] = [];
  for (const r of taskRows) {
    const row: PointingTaskRow = {
      id: r.id,
      title: r.title ?? "",
      status: String(r.status ?? ""),
      kind: r.kind,
      tags: parseTags(r.tags),
      parentId: parentOf.get(r.id) ?? null,
      updatedAtMs: r.updatedAt ? new Date(r.updatedAt).getTime() : 0,
      originLine: originLineOf(r.origin),
    };
    if (isPointingCandidateRow(row)) rows.push(row);
  }
  return { rows, ancestorsOf: buildAncestorLookup(parentOf) };
}

/** Ids of the open, eligible tasks a query matches — the remainder sweep's evaluator. */
export async function evaluatePointingQuery(
  db: PostgresJsDatabase,
  query: PointingQuery,
  projectScope: ProjectScope
): Promise<string[]> {
  const { rows, ancestorsOf } = await loadCandidateRows(db, projectScope);
  return rows.filter((r) => taskMatchesPointingQuery(r, query, ancestorsOf)).map((r) => r.id);
}

/** Load dependency edges and dependent counts for the matched ids, in two queries. */
async function loadSignals(db: PostgresJsDatabase, matchedIds: string[]) {
  const dependsOn = new Map<string, string[]>();
  const openDependents = new Map<string, number>();
  const statusOf = new Map<string, string>();
  if (matchedIds.length === 0) return { dependsOn, openDependents, statusOf };

  const outgoing = await db
    .select({ from: taskRelationshipsTable.fromTaskId, to: taskRelationshipsTable.toTaskId })
    .from(taskRelationshipsTable)
    .where(
      and(
        eq(taskRelationshipsTable.type, "depends"),
        inArray(taskRelationshipsTable.fromTaskId, matchedIds)
      )
    );
  for (const e of outgoing) {
    const list = dependsOn.get(e.from) ?? [];
    list.push(e.to);
    dependsOn.set(e.from, list);
  }

  const incoming = await db
    .select({ from: taskRelationshipsTable.fromTaskId, to: taskRelationshipsTable.toTaskId })
    .from(taskRelationshipsTable)
    .where(
      and(
        eq(taskRelationshipsTable.type, "depends"),
        inArray(taskRelationshipsTable.toTaskId, matchedIds)
      )
    );

  const referenced = new Set<string>();
  for (const e of outgoing) referenced.add(e.to);
  for (const e of incoming) referenced.add(e.from);
  if (referenced.size > 0) {
    const statusRows = await db
      .select({ id: tasksTable.id, status: tasksTable.status })
      .from(tasksTable)
      .where(inArray(tasksTable.id, [...referenced]));
    for (const s of statusRows) statusOf.set(s.id, String(s.status ?? ""));
  }
  for (const e of incoming) {
    const s = statusOf.get(e.from);
    if (s !== undefined && !isTerminal(s))
      openDependents.set(e.to, (openDependents.get(e.to) ?? 0) + 1);
  }
  return { dependsOn, openDependents, statusOf };
}

export interface CandidateSetResult extends CandidateSet {
  pointing: Pick<PointingRecord, "id" | "name" | "autonomyClass" | "wipLimit">;
}

/** The read the RFC asks for: saved query in, capped unordered candidate set out. */
export async function computeCandidateSet(
  db: PostgresJsDatabase,
  pointing: PointingRecord,
  options: { cap?: number; seed?: number; nowMs?: number } = {}
): Promise<CandidateSetResult> {
  const scope: ProjectScope = pointing.projectId ?? ALL_PROJECTS;
  const { rows, ancestorsOf } = await loadCandidateRows(db, scope);
  const matched = rows.filter((r) => taskMatchesPointingQuery(r, pointing.query, ancestorsOf));
  const signals = await loadSignals(
    db,
    matched.map((r) => r.id)
  );
  const set = selectCandidates(matched, signals, options);
  return {
    ...set,
    pointing: {
      id: pointing.id,
      name: pointing.name,
      autonomyClass: pointing.autonomyClass,
      wipLimit: pointing.wipLimit,
    },
  };
}

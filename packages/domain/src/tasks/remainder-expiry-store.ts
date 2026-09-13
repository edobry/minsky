/**
 * Remainder disposition — the DB shell (mt#5131).
 *
 * Loads what `planRemainderSweep` needs (the non-terminal backlog plus the
 * parked rows, the live pointings, the parent edges), applies the plan, and
 * emits the audit trail. Writes go straight to the Drizzle tables inside one
 * transaction — the same posture as `work-package-claim.ts`: the status
 * change is CAS-guarded on the status the plan saw, so a task a session picked
 * up between plan and apply is left alone rather than closed from under it.
 *
 * Every applied row emits `task.status_changed` (best-effort, after the
 * transaction) with `via` naming this mechanism, so the event ledger — the
 * one peer probe that answers rather than signals — records each park and
 * each resurrection. An executed sweep additionally emits ONE
 * `remainder.expiry.run` row carrying the counts, the id lists and the
 * pointings it checked against, so a run is a ledger entry in its own right.
 */

import { and, eq, inArray, isNotNull, like, not, or, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { log } from "@minsky/shared/logger";
import { getLoggableErrorSummary } from "../errors/index";
import { ALL_PROJECTS, type ProjectScope } from "../project/scope";
import { tasksTable, taskSpecsTable } from "../storage/schemas/task-embeddings";
import { buildAncestorLookup } from "./pointings";
import { listPointings, loadParentOf, type PointingRecord } from "./pointings-store";
import {
  AUTO_EXPIRED_TAG,
  autoExpiredSection,
  planRemainderSweep,
  resurrectedSection,
  tagsAfterPark,
  tagsAfterResurrect,
  type RemainderPlan,
  type RemainderPointing,
  type RemainderTaskRow,
} from "./remainder-expiry";

export interface RemainderSweepOptions {
  projectScope: ProjectScope;
  /** Apply the plan; `false` (the default everywhere) reports it. */
  execute?: boolean;
  nowMs?: number;
  ageDays?: number;
  /** Parks per run; `undefined` = uncapped. The ops loop passes its cap; the CLI does not. */
  cap?: number;
  /** Names the caller in each event's `via` — `cli` or `ops-loop`. */
  via: string;
  /**
   * Runs between the plan and its application — the seam the plan/apply race
   * tests use to move a row after it was planned and assert the CAS guards
   * skip it. Production callers leave it unset.
   */
  beforeApply?: () => Promise<void>;
}

export interface RemainderSweepResult {
  dryRun: boolean;
  plan: RemainderPlan;
  /** What was actually written — empty on a dry run, and possibly smaller than the plan when a CAS guard refused. */
  applied: { parked: string[]; resurrected: string[] };
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    // intentional-swallow: a malformed tags column reads as untagged; the row is still evaluated.
    return [];
  }
}

function toPointing(p: PointingRecord): RemainderPointing {
  return { id: p.id, name: p.name, query: p.query };
}

interface LoadedRow extends RemainderTaskRow {
  rawTags: string[];
}

/**
 * The rows the plan evaluates: everything non-terminal (candidates), plus the
 * CLOSED rows this mechanism parked (resurrection). Hand-closed rows are not
 * loaded — they are nobody's to reopen.
 */
/**
 * "Carries the `auto-expired` tag", as a SQL predicate over the JSON-text
 * `tasks.tags` column. The quotes in the pattern are what make it exact: a
 * JSON array element is always `"auto-expired"` with both quotes, so a longer
 * tag such as `"not-auto-expired"` does not match (its leading character is
 * `-`, not `"`), and no tag can contain a raw `"`. The column is text rather
 * than jsonb — the repo-wide tags convention, not this module's to change —
 * so JSON operators and a GIN index are unavailable here; the plan re-checks
 * membership on the parsed array (`isParkedRow`) after the load regardless.
 */
const carriesAutoExpiredTag = (): SQL => like(tasksTable.tags, `%"${AUTO_EXPIRED_TAG}"%`);

async function loadRows(
  db: PostgresJsDatabase,
  projectScope: ProjectScope,
  nowMs: number
): Promise<LoadedRow[]> {
  const conditions: SQL[] = [
    // A NULL status is neither open nor parked; `NOT IN` already yields NULL
    // (excluded) for it, and the explicit predicate keeps that visible so the
    // status CAS below never compares against a coerced empty string.
    isNotNull(tasksTable.status),
    or(
      not(inArray(tasksTable.status, ["DONE", "CLOSED"])),
      and(eq(tasksTable.status, "CLOSED"), carriesAutoExpiredTag())
    ) as SQL,
  ];
  if (projectScope !== ALL_PROJECTS) conditions.push(eq(tasksTable.projectId, projectScope));
  const rows = await db
    .select({
      id: tasksTable.id,
      status: tasksTable.status,
      kind: tasksTable.kind,
      tags: tasksTable.tags,
      updatedAt: tasksTable.updatedAt,
      createdAt: tasksTable.createdAt,
    })
    .from(tasksTable)
    .where(and(...conditions));
  return rows.map((r) => {
    const tags = parseTags(r.tags);
    // A legacy NULL updated_at falls back to created_at, then to "now" —
    // never epoch zero, which would read as decades untouched.
    const touched = r.updatedAt ?? r.createdAt;
    return {
      id: r.id,
      status: String(r.status ?? ""),
      kind: r.kind,
      tags,
      rawTags: tags,
      updatedAtMs: touched ? new Date(touched).getTime() : nowMs,
    };
  });
}

async function emitStatusChanged(
  db: PostgresJsDatabase,
  payload: { taskId: string; previousStatus: string; newStatus: string; via: string }
): Promise<void> {
  try {
    const { DrizzleEventEmitter } = await import("../events/emitter");
    await new DrizzleEventEmitter(db).emit({
      eventType: "task.status_changed",
      payload,
      relatedTaskId: payload.taskId,
    });
  } catch (err: unknown) {
    log.warn("task.status_changed: event emission failed (best-effort, swallowed)", {
      taskId: payload.taskId,
      error: getLoggableErrorSummary(err),
    });
  }
}

/**
 * The run-level ledger record of an EXECUTED sweep (payload shape documented
 * on `SYSTEM_EVENT_TYPE_VALUES`). One row per run, after the transaction
 * commits, so a bulk park is attributable to a run rather than reconstructed
 * from its per-task rows. Best-effort like the per-task emit: the writes have
 * already landed, and a ledger failure must not report the sweep as failed.
 */
async function emitRunRecord(
  db: PostgresJsDatabase,
  plan: RemainderPlan,
  applied: { parked: string[]; resurrected: string[] },
  via: string
): Promise<void> {
  try {
    const { DrizzleEventEmitter } = await import("../events/emitter");
    await new DrizzleEventEmitter(db).emit({
      eventType: "remainder.expiry.run",
      payload: {
        via,
        parked: applied.parked,
        resurrected: applied.resurrected,
        parkedCount: applied.parked.length,
        resurrectedCount: applied.resurrected.length,
        pointingIds: plan.pointingIds,
        ...(plan.parkingSuspended ? { parkingSuspended: plan.parkingSuspended } : {}),
        capped: plan.capped,
      },
    });
  } catch (err: unknown) {
    log.warn("remainder.expiry.run: event emission failed (best-effort, swallowed)", {
      via,
      error: getLoggableErrorSummary(err),
    });
  }
}

type Tx = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];

/**
 * Append a section to a task's spec, creating the spec row when the task has
 * none. A blind UPDATE would affect zero rows there and the park or
 * resurrection would land without its annotation (PR #3747 R1) — the section
 * IS the audit record, so it is written unconditionally: INSERT the section as
 * the whole spec, or on conflict append it to what is there.
 */
async function appendSpecSection(tx: Tx, taskId: string, section: string, now: Date) {
  await tx
    .insert(taskSpecsTable)
    .values({ taskId, content: section.replace(/^\n+/, ""), updatedAt: now })
    .onConflictDoUpdate({
      target: taskSpecsTable.taskId,
      set: { content: sql`${taskSpecsTable.content} || ${section}`, updatedAt: now },
    });
}

/**
 * Apply a plan against rows the plan was computed from. Each write is guarded
 * on what the plan saw — the park on the row's status, the resurrection on
 * `CLOSED` AND the tag (a hand-closed row, or one whose tag was removed after
 * the plan, is never reopened); a row that moved in between is skipped and
 * reported as not applied.
 */
async function applyPlan(
  db: PostgresJsDatabase,
  plan: RemainderPlan,
  rowsById: ReadonlyMap<string, LoadedRow>,
  pointingsById: ReadonlyMap<string, RemainderPointing>,
  nowMs: number,
  via: string
): Promise<RemainderSweepResult["applied"]> {
  const now = new Date(nowMs);
  const parked: string[] = [];
  const resurrected: string[] = [];
  const events: Array<{ taskId: string; previousStatus: string; newStatus: string }> = [];

  await db.transaction(async (tx) => {
    for (const id of plan.park) {
      const row = rowsById.get(id);
      if (!row) continue;
      const updated = await tx
        .update(tasksTable)
        .set({
          status: "CLOSED",
          tags: JSON.stringify(tagsAfterPark(row.rawTags)),
          updatedAt: now,
        })
        .where(
          and(
            eq(tasksTable.id, id),
            eq(
              tasksTable.status,
              row.status as NonNullable<(typeof tasksTable.$inferSelect)["status"]>
            )
          )
        )
        .returning({ id: tasksTable.id });
      if (updated.length === 0) continue;
      await appendSpecSection(tx, id, autoExpiredSection(nowMs, plan.pointingIds), now);
      parked.push(id);
      events.push({ taskId: id, previousStatus: row.status, newStatus: "CLOSED" });
    }

    for (const r of plan.resurrect) {
      const row = rowsById.get(r.id);
      const pointing = pointingsById.get(r.pointingId);
      if (!row || !pointing) continue;
      const updated = await tx
        .update(tasksTable)
        .set({
          status: "TODO",
          tags: JSON.stringify(tagsAfterResurrect(row.rawTags)),
          updatedAt: now,
        })
        .where(
          and(eq(tasksTable.id, r.id), eq(tasksTable.status, "CLOSED"), carriesAutoExpiredTag())
        )
        .returning({ id: tasksTable.id });
      if (updated.length === 0) continue;
      await appendSpecSection(tx, r.id, resurrectedSection(nowMs, pointing), now);
      resurrected.push(r.id);
      events.push({ taskId: r.id, previousStatus: "CLOSED", newStatus: "TODO" });
    }
  });

  for (const e of events) await emitStatusChanged(db, { ...e, via });
  return { parked, resurrected };
}

/** The sweep: plan over the live inputs, apply when asked. */
export async function runRemainderSweep(
  db: PostgresJsDatabase,
  options: RemainderSweepOptions
): Promise<RemainderSweepResult> {
  const nowMs = options.nowMs ?? Date.now();
  const execute = options.execute === true;
  const pointings = (await listPointings(db, { projectScope: options.projectScope })).map(
    toPointing
  );
  const [rows, parentOf] = await Promise.all([
    loadRows(db, options.projectScope, nowMs),
    loadParentOf(db),
  ]);
  const plan = planRemainderSweep(rows, pointings, buildAncestorLookup(parentOf), {
    nowMs,
    ageDays: options.ageDays,
    cap: options.cap,
  });
  if (!execute) return { dryRun: true, plan, applied: { parked: [], resurrected: [] } };

  if (options.beforeApply) await options.beforeApply();
  const applied = await applyPlan(
    db,
    plan,
    new Map(rows.map((r) => [r.id, r])),
    new Map(pointings.map((p) => [p.id, p])),
    nowMs,
    options.via
  );
  await emitRunRecord(db, plan, applied, options.via);
  return { dryRun: false, plan, applied };
}

/**
 * Resurrection for ONE pointing, run inside `pointings.declare` so a pointing
 * declared after a park brings its tasks back in the same call rather than on
 * the next tick. Parks nothing.
 */
export async function resurrectForPointing(
  db: PostgresJsDatabase,
  pointing: PointingRecord,
  options: { nowMs?: number; via?: string } = {}
): Promise<string[]> {
  const nowMs = options.nowMs ?? Date.now();
  const scope: ProjectScope = pointing.projectId ?? ALL_PROJECTS;
  const [rows, parentOf] = await Promise.all([loadRows(db, scope, nowMs), loadParentOf(db)]);
  const single = toPointing(pointing);
  const plan = planRemainderSweep(rows, [single], buildAncestorLookup(parentOf), {
    nowMs,
    cap: 0,
  });
  if (plan.resurrect.length === 0) return [];
  const applied = await applyPlan(
    db,
    { ...plan, park: [] },
    new Map(rows.map((r) => [r.id, r])),
    new Map([[single.id, single]]),
    nowMs,
    options.via ?? "pointings.declare"
  );
  return applied.resurrected;
}

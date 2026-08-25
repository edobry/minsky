/**
 * Drizzle-backed implementation of {@link SupervisionStore} (mt#4571), plus the
 * create/stop/read operations the `tasks.supervise*` commands use.
 *
 * Every method here is a narrow read or write; all the decision-making lives in
 * `./supervision-tick.ts`, which takes the interface rather than this class so
 * the DAG-walking behaviour is testable without a database.
 *
 * @see ./types.ts — the interface this satisfies
 * @see ../storage/schemas/task-supervisions-schema.ts — the tables
 */
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  IN_FLIGHT_DISPATCH_STATUSES,
  taskSupervisionDispatchesTable,
  taskSupervisionsTable,
  type SupervisionStatus,
  type TaskSupervisionDispatchRecord,
  type TaskSupervisionRecord,
} from "../storage/schemas/task-supervisions-schema";
import { systemEventsTable } from "../storage/schemas/system-events-schema";
import type {
  DispatchView,
  SettledBy,
  SupervisionDispatchStatus,
  SupervisionStore,
  SupervisionView,
} from "./types";

/**
 * Fixed advisory-lock namespace for supervision-tick exclusion (mt#4571 SC6).
 *
 * Stable and distinct from the sibling namespaces in this codebase —
 * `DRIVEN_SESSION_RESUME_LOCK_NAMESPACE` (3_038_001) and `TURN_WRITE_LOCK_NAMESPACE`
 * — so the two-key `pg_try_advisory_xact_lock(int, int)` overload can pair it
 * with `hashtext(supervisionId)` without any JS-side hashing.
 */
const SUPERVISION_TICK_LOCK_NAMESPACE = 4_571_001;

/** Default child statuses a supervision treats as dispatchable. */
export const DEFAULT_SUPERVISION_STATUS_FILTER = ["TODO", "READY"] as const;

/**
 * Default WIP limit — see the column docblock in the schema for the measurement.
 * Repeated here because a caller reads this constant, not the DDL default.
 */
export const DEFAULT_SUPERVISION_WIP_LIMIT = 4;

function toSupervisionView(row: TaskSupervisionRecord): SupervisionView {
  return {
    id: row.id,
    umbrellaTaskId: row.umbrellaTaskId,
    status: row.status as SupervisionStatus,
    statusFilter: row.statusFilter
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    wipLimit: row.wipLimit,
    model: row.model,
    eventsWatermark: row.eventsWatermark,
    lastTickAt: row.lastTickAt,
    lastAdvanceAt: row.lastAdvanceAt,
    lastHoldReason: row.lastHoldReason,
  };
}

function toDispatchView(row: TaskSupervisionDispatchRecord): DispatchView {
  return {
    id: row.id,
    supervisionId: row.supervisionId,
    taskId: row.taskId,
    status: row.status as SupervisionDispatchStatus,
    drivenSessionLocalId: row.drivenSessionLocalId,
    minskySessionId: row.minskySessionId,
    dispatchedAt: row.dispatchedAt,
  };
}

export class DrizzleSupervisionStore implements SupervisionStore {
  constructor(private readonly db: PostgresJsDatabase<Record<string, unknown>>) {}

  async listActiveSupervisions(): Promise<SupervisionView[]> {
    const rows = await this.db
      .select()
      .from(taskSupervisionsTable)
      .where(eq(taskSupervisionsTable.status, "active"))
      .orderBy(asc(taskSupervisionsTable.createdAt));
    return rows.map(toSupervisionView);
  }

  async withSupervisionLock<T>(supervisionId: string, fn: () => Promise<T>): Promise<T | null> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute(
        sql`SELECT pg_try_advisory_xact_lock(${SUPERVISION_TICK_LOCK_NAMESPACE}, hashtext(${supervisionId})) AS acquired`
      );
      const row = Array.from(rows as Iterable<Record<string, unknown>>)[0];
      if (row?.["acquired"] !== true) return null;
      return await fn();
    });
  }

  async listInFlightDispatches(supervisionId: string): Promise<DispatchView[]> {
    const rows = await this.db
      .select()
      .from(taskSupervisionDispatchesTable)
      .where(
        and(
          eq(taskSupervisionDispatchesTable.supervisionId, supervisionId),
          inArray(taskSupervisionDispatchesTable.status, [...IN_FLIGHT_DISPATCH_STATUSES])
        )
      )
      .orderBy(asc(taskSupervisionDispatchesTable.dispatchedAt));
    return rows.map(toDispatchView);
  }

  async listDispatchedTaskIds(supervisionId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ taskId: taskSupervisionDispatchesTable.taskId })
      .from(taskSupervisionDispatchesTable)
      .where(eq(taskSupervisionDispatchesTable.supervisionId, supervisionId));
    return new Set(rows.map((r) => r.taskId));
  }

  async listMergedSince(
    since: Date | null,
    limit: number
  ): Promise<Array<{ taskId: string; at: Date }>> {
    const conditions = [eq(systemEventsTable.eventType, "pr.merged")];
    if (since !== null) conditions.push(gte(systemEventsTable.createdAt, since));

    const rows = await this.db
      .select({
        relatedTaskId: systemEventsTable.relatedTaskId,
        createdAt: systemEventsTable.createdAt,
      })
      .from(systemEventsTable)
      .where(and(...conditions))
      .orderBy(asc(systemEventsTable.createdAt))
      .limit(limit);

    const out: Array<{ taskId: string; at: Date }> = [];
    for (const row of rows) {
      if (!row.relatedTaskId) continue;
      out.push({ taskId: row.relatedTaskId, at: row.createdAt });
    }
    return out;
  }

  async recordDispatch(input: {
    supervisionId: string;
    taskId: string;
    drivenSessionLocalId: string;
    minskySessionId: string | null;
  }): Promise<void> {
    // ON CONFLICT DO NOTHING against uq_task_supervision_dispatches_supervision_task.
    // A tick that crashed after spawning but before recording, then re-ran,
    // must not create a second row — and the row it would collide with is the
    // evidence that a child is already running for this task.
    await this.db
      .insert(taskSupervisionDispatchesTable)
      .values({
        supervisionId: input.supervisionId,
        taskId: input.taskId,
        drivenSessionLocalId: input.drivenSessionLocalId,
        minskySessionId: input.minskySessionId,
        status: "dispatched",
      })
      .onConflictDoNothing({
        target: [
          taskSupervisionDispatchesTable.supervisionId,
          taskSupervisionDispatchesTable.taskId,
        ],
      });
  }

  async settleDispatch(input: {
    dispatchId: string;
    status: SupervisionDispatchStatus;
    settledBy: SettledBy;
    lastError: string | null;
    at: Date;
  }): Promise<void> {
    // Status-guarded: only an in-flight row settles, so a concurrent tick that
    // already settled it cannot have its verdict overwritten by a later one.
    await this.db
      .update(taskSupervisionDispatchesTable)
      .set({
        status: input.status,
        settledBy: input.settledBy,
        lastError: input.lastError,
        settledAt: input.at,
      })
      .where(
        and(
          eq(taskSupervisionDispatchesTable.id, input.dispatchId),
          inArray(taskSupervisionDispatchesTable.status, [...IN_FLIGHT_DISPATCH_STATUSES])
        )
      );
  }

  async updateSupervision(input: {
    supervisionId: string;
    status?: SupervisionStatus;
    eventsWatermark?: Date | null;
    lastTickAt?: Date;
    lastAdvanceAt?: Date;
    lastHoldReason?: string | null;
    lastError?: string | null;
  }): Promise<void> {
    const patch: Partial<TaskSupervisionRecord> = { updatedAt: new Date() };
    if (input.status !== undefined) patch.status = input.status;
    if (input.eventsWatermark !== undefined) patch.eventsWatermark = input.eventsWatermark;
    if (input.lastTickAt !== undefined) patch.lastTickAt = input.lastTickAt;
    if (input.lastAdvanceAt !== undefined) patch.lastAdvanceAt = input.lastAdvanceAt;
    if (input.lastHoldReason !== undefined) patch.lastHoldReason = input.lastHoldReason;
    if (input.lastError !== undefined) patch.lastError = input.lastError;
    if (input.status === "completed" || input.status === "stopped") {
      patch.stoppedAt = input.lastTickAt ?? new Date();
    }

    await this.db
      .update(taskSupervisionsTable)
      .set(patch)
      .where(eq(taskSupervisionsTable.id, input.supervisionId));
  }

  // -------------------------------------------------------------------------
  // Operations behind the `tasks.supervise*` commands (not part of the tick)
  // -------------------------------------------------------------------------

  /**
   * Start supervising an umbrella.
   *
   * Returns the EXISTING active supervision when one is already running for
   * this umbrella rather than creating a second — the partial unique index
   * `uq_task_supervisions_active_umbrella` makes that a database guarantee, so
   * two concurrent callers cannot both win.
   */
  async createSupervision(input: {
    umbrellaTaskId: string;
    statusFilter: readonly string[];
    wipLimit: number;
    model: string | null;
  }): Promise<{ supervision: SupervisionView; created: boolean }> {
    const [inserted] = await this.db
      .insert(taskSupervisionsTable)
      .values({
        umbrellaTaskId: input.umbrellaTaskId,
        statusFilter: input.statusFilter.join(","),
        wipLimit: input.wipLimit,
        model: input.model,
        status: "active",
      })
      .onConflictDoNothing()
      .returning();

    if (inserted) return { supervision: toSupervisionView(inserted), created: true };

    const existing = await this.getActiveSupervision(input.umbrellaTaskId);
    if (!existing) {
      throw new Error(
        `createSupervision: insert for ${input.umbrellaTaskId} conflicted but no active supervision was found`
      );
    }
    return { supervision: existing, created: false };
  }

  async getActiveSupervision(umbrellaTaskId: string): Promise<SupervisionView | null> {
    const [row] = await this.db
      .select()
      .from(taskSupervisionsTable)
      .where(
        and(
          eq(taskSupervisionsTable.umbrellaTaskId, umbrellaTaskId),
          eq(taskSupervisionsTable.status, "active")
        )
      )
      .limit(1);
    return row ? toSupervisionView(row) : null;
  }

  /** Most recent supervision for an umbrella in ANY state — the read surface's subject. */
  async getLatestSupervision(umbrellaTaskId: string): Promise<SupervisionView | null> {
    const [row] = await this.db
      .select()
      .from(taskSupervisionsTable)
      .where(eq(taskSupervisionsTable.umbrellaTaskId, umbrellaTaskId))
      .orderBy(desc(taskSupervisionsTable.createdAt))
      .limit(1);
    return row ? toSupervisionView(row) : null;
  }

  /** Every dispatch for a supervision, newest first — SC10's visible record. */
  async listDispatches(supervisionId: string): Promise<DispatchView[]> {
    const rows = await this.db
      .select()
      .from(taskSupervisionDispatchesTable)
      .where(eq(taskSupervisionDispatchesTable.supervisionId, supervisionId))
      .orderBy(desc(taskSupervisionDispatchesTable.dispatchedAt));
    return rows.map(toDispatchView);
  }

  /**
   * Stop an active supervision.
   *
   * Deliberately does NOT stop the children it already dispatched: they are
   * ordinary driven sessions doing real work, and killing them would discard
   * uncommitted output. Stopping means "dispatch nothing further".
   */
  async stopSupervision(umbrellaTaskId: string): Promise<SupervisionView | null> {
    const [row] = await this.db
      .update(taskSupervisionsTable)
      .set({ status: "stopped", stoppedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(taskSupervisionsTable.umbrellaTaskId, umbrellaTaskId),
          eq(taskSupervisionsTable.status, "active")
        )
      )
      .returning();
    return row ? toSupervisionView(row) : null;
  }
}

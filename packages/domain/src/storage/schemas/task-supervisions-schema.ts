/**
 * Task supervision tables (mt#4571) — the durable answer to "which umbrellas
 * are being walked unattended, what did the supervisor start, and what is it
 * waiting on?"
 *
 * The principal's ask this exists for, verbatim: *"I want to assign the umbrella
 * so that I can be confident that I kicked off the entire work stream and that
 * it's being worked on. I can then leave my computer for a few hours and know
 * that the 'supervisor agent' will proceed to walk that task tree without me
 * having to watch."*
 *
 * Storage-backed rather than in-memory for the same reason
 * `scheduled_follow_ups` is (mt#2322): the row is the durable state and the
 * periodic sweep is the reconciliation loop, per
 * `decision-defaults.mdc §Reliability`'s sweeper-over-queue default. A
 * supervision must outlive the daemon restart that happens while the operator
 * is away — that is the entire point of the feature.
 *
 * **Why a new table rather than extending mt#3038's `driven_sessions`.** That
 * table records one row per CONVERSATION the daemon drives. A supervision is not
 * a conversation: it outlives every conversation it starts, it exists before the
 * first one is spawned, and it survives all of them completing. The dispatch
 * table below is the join between the two.
 *
 * @see mt#4571 — the supervisor
 * @see ../../supervision/ — the store and the tick that read these
 * @see mt#2750 / mt#3038 — the driven-session spawn host and its persistence,
 *   which this consumes rather than reimplements
 */
import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Supervision lifecycle.
 *
 * `active` -> `completed` when the umbrella's frontier is empty and nothing is
 * in flight; `active` -> `stopped` on an explicit operator stop; `active` ->
 * `failed` when the tick itself could not run for this supervision (never when a
 * CHILD fails — a failed child is a dispatch row, and the supervision keeps
 * going, per mt#4571 SC10).
 */
export const SUPERVISION_STATUS_VALUES = ["active", "completed", "stopped", "failed"] as const;
export type SupervisionStatus = (typeof SUPERVISION_STATUS_VALUES)[number];

/**
 * Per-child dispatch lifecycle.
 *
 * `dispatched` -> `succeeded` (the child's PR merged, or its task reached a
 * terminal status) / `failed` (its driven session crashed or exited non-zero) /
 * `stranded` (the session is gone but the task never reached a terminal status —
 * the case that is invisible from either signal alone, and the one mt#4571 SC10
 * exists for).
 */
export const SUPERVISION_DISPATCH_STATUS_VALUES = [
  "dispatched",
  "succeeded",
  "failed",
  "stranded",
] as const;
export type SupervisionDispatchStatus = (typeof SUPERVISION_DISPATCH_STATUS_VALUES)[number];

/** Dispatch states that still occupy a WIP slot. */
export const IN_FLIGHT_DISPATCH_STATUSES: readonly SupervisionDispatchStatus[] = ["dispatched"];

export const taskSupervisionsTable = pgTable(
  "task_supervisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** The umbrella task under supervision (e.g. "mt#4553"). */
    umbrellaTaskId: text("umbrella_task_id").notNull(),

    /** Current lifecycle state. Only `active` rows are ticked. */
    status: text("status").notNull().default("active"),

    /**
     * Child statuses the supervisor treats as dispatchable, stored EXPLICITLY
     * rather than defaulted at read time (mt#4571 SC5).
     *
     * `tasks.orchestrate` defaults this to `["TODO"]`, which would make a
     * supervisor silently skip every PLANNING, READY, IN-PROGRESS and IN-REVIEW
     * child — exactly the ones already planned. Persisting the set the operator
     * started with also means a later change to any default cannot silently
     * re-scope a supervision that is already running.
     *
     * Stored comma-separated rather than as a `text[]`: the value is a short
     * fixed vocabulary read as a whole, never queried element-wise.
     */
    statusFilter: text("status_filter").notNull(),

    /**
     * Maximum concurrently-dispatched children (mt#4571 SC7).
     *
     * Default 4, grounded in measurement rather than picked
     * (`decision-defaults.mdc §Thresholds`). Per-umbrella peak concurrency over
     * the 60 days to 2026-08-25, across 86 umbrellas with at least one
     * measurable child span: median peak 1, p90 1, p95 2, observed max 4. The
     * limit is the observed MAXIMUM — the median would refuse parallelism that
     * has demonstrably happened, and a round 8 or 10 would have no observed
     * support at all. Whole-system concurrency over the same window was median
     * 8 / p95 14 / peak 22, so one supervised umbrella at its cap cannot
     * monopolize observed capacity.
     */
    wipLimit: integer("wip_limit").notNull().default(4),

    /**
     * Dispatch model alias for children (e.g. "sonnet"). Null -> the `claude`
     * binary's own default resolution, the pre-mt#3040 behaviour.
     */
    model: text("model"),

    /**
     * High-water mark over `system_events.created_at` for the `pr.merged` reads
     * that settle dispatches (mt#4571 SC3). Null before the first tick.
     *
     * NOT a `task.status_changed` watermark: that event's only emitter is the
     * `tasks_status_set` path, and a merge-driven DONE goes through
     * `applyPostMergeStateSync` -> `taskService.setTaskStatus`, which emits
     * nothing. mt#4574 owns closing that gap.
     */
    eventsWatermark: timestamp("events_watermark", { withTimezone: true }),

    /** When the supervisor last evaluated this umbrella. Liveness of the TICK. */
    lastTickAt: timestamp("last_tick_at", { withTimezone: true }),

    /**
     * When the supervisor last DISPATCHED or SETTLED something — progress, as
     * distinct from `lastTickAt`'s mere aliveness.
     *
     * The separation is what makes mt#4571 SC9's semantic stall detectable: a
     * healthy tick that has moved nothing for the threshold interval looks
     * identical to a healthy tick with nothing to do, and `startSweepMetaWatchdog`
     * — which watches for a DEAD tick — structurally cannot see either.
     */
    lastAdvanceAt: timestamp("last_advance_at", { withTimezone: true }),

    /** Why the last tick dispatched nothing (e.g. "wip-limit", "frontier-empty"). */
    lastHoldReason: text("last_hold_reason"),

    /** Error from a tick that could not run for this supervision (status = "failed"). */
    lastError: text("last_error"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  },
  (table) => [
    // Sweep hot path: WHERE status = 'active'.
    index("idx_task_supervisions_status").on(table.status),
    // At most one ACTIVE supervision per umbrella. Enforced in the database
    // rather than by a read-then-write in the store, because two daemons (or a
    // daemon and a CLI) can issue `tasks.supervise` concurrently and a
    // check-then-insert would admit both — producing two supervisors racing to
    // dispatch the same children. A partial index rather than a plain unique so
    // an umbrella can be supervised again after a previous run completed.
    uniqueIndex("uq_task_supervisions_active_umbrella")
      .on(table.umbrellaTaskId)
      .where(sql.raw("status = 'active'")),
  ]
);

export const taskSupervisionDispatchesTable = pgTable(
  "task_supervision_dispatches",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** Owning supervision. */
    supervisionId: uuid("supervision_id")
      .notNull()
      .references(() => taskSupervisionsTable.id, { onDelete: "cascade" }),

    /** The child task that was dispatched (e.g. "mt#4554"). */
    taskId: text("task_id").notNull(),

    /** Current dispatch state. */
    status: text("status").notNull().default("dispatched"),

    /** `driven_sessions.local_id` of the conversation started for this child. */
    drivenSessionLocalId: text("driven_session_local_id"),

    /** The Minsky workspace session the child was bound to. */
    minskySessionId: text("minsky_session_id"),

    /** Which signal settled this dispatch ("pr.merged", "task-status", "session-exit"). */
    settledBy: text("settled_by"),

    /** Error text for a failed or stranded dispatch. Never set on success. */
    lastError: text("last_error"),

    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }).defaultNow().notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    // Reconciliation hot path: the in-flight set for one supervision.
    index("idx_task_supervision_dispatches_supervision_status").on(
      table.supervisionId,
      table.status
    ),
    // One dispatch per child per supervision. This is the idempotence guarantee
    // the tick relies on: a tick that crashes after spawning but before
    // recording, then re-runs, must not start a SECOND `claude` child on the
    // same task. The insert is `ON CONFLICT DO NOTHING` against this index.
    uniqueIndex("uq_task_supervision_dispatches_supervision_task").on(
      table.supervisionId,
      table.taskId
    ),
  ]
);

export type TaskSupervisionRecord = typeof taskSupervisionsTable.$inferSelect;
export type TaskSupervisionInsert = typeof taskSupervisionsTable.$inferInsert;
export type TaskSupervisionDispatchRecord = typeof taskSupervisionDispatchesTable.$inferSelect;
export type TaskSupervisionDispatchInsert = typeof taskSupervisionDispatchesTable.$inferInsert;

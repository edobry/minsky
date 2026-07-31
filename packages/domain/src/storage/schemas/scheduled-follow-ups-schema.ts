import { pgTable, uuid, text, timestamp, jsonb, index, pgEnum } from "drizzle-orm/pg-core";

/**
 * Scheduled follow-ups table — the first consumer of the cockpit-daemon
 * recurring-job scheduler facility (mt#2322, remaining scope of mt#2234).
 *
 * A follow-up is a one-shot "fire at this time" primitive: create it with a
 * message + `dueAt`, and the daemon's follow-up sweeper (see
 * `src/cockpit/sweepers.ts`'s `startFollowUpSweeper`) picks it up on its next
 * tick once `dueAt` has passed. Storage-backed (not an in-memory `setTimeout`)
 * so a follow-up survives a daemon restart between creation and its due time —
 * consistent with the project's sweeper-not-durable-queue default
 * (`decision-defaults.mdc §Reliability`): the DB row is the durable state, the
 * periodic sweep is the reconciliation loop, no second scheduling primitive is
 * introduced.
 *
 * @see mt#2322 — Cockpit-daemon recurring-job scheduler facility + scheduled-follow-up primitive
 * @see mt#2234 — parent (scope narrowed to mt#2322 as of 2026-07-18; see spec)
 */

/**
 * Follow-up lifecycle. `pending` -> `fired` (happy path, sweep picked it up
 * after `dueAt`) or `pending` -> `cancelled` (explicit cancel before firing).
 * `failed` is reserved for a firing attempt that itself errored (kept
 * separate from `fired` so a caller can distinguish "we tried and it broke"
 * from "it fired cleanly" without inspecting `lastError`).
 */
export const FOLLOW_UP_STATUS_VALUES = ["pending", "fired", "cancelled", "failed"] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUS_VALUES)[number];
export const followUpStatusEnum = pgEnum("follow_up_status", FOLLOW_UP_STATUS_VALUES);

export const scheduledFollowUpsTable = pgTable(
  "scheduled_follow_ups",
  {
    /** Surrogate primary key. */
    id: uuid("id").defaultRandom().primaryKey(),

    /** Human-readable follow-up text — what the operator/agent should be reminded of. */
    message: text("message").notNull(),

    /** Free-form structured context (e.g. { source, kind }). Never required to fire. */
    payload: jsonb("payload").notNull().default({}),

    /** When this follow-up should fire. Indexed — the sweep's hot-path filter column. */
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),

    /** Current lifecycle state. Only `pending` rows are eligible to fire. */
    status: followUpStatusEnum("status").notNull().default("pending"),

    /** Optional related Minsky task ID (e.g. "mt#123"), for follow-ups tied to a task. */
    relatedTaskId: text("related_task_id"),

    /** Optional related Minsky session ID, for follow-ups tied to a session. */
    relatedSessionId: text("related_session_id"),

    /** When the follow-up was created. */
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),

    /** When the follow-up actually fired (or the failed attempt occurred), or null. */
    firedAt: timestamp("fired_at", { withTimezone: true }),

    /** Error message from a failed firing attempt (status = "failed"). Never set otherwise. */
    lastError: text("last_error"),
  },
  (table) => [
    // Sweep hot path: WHERE status = 'pending' AND due_at <= now().
    index("idx_scheduled_follow_ups_status_due_at").on(table.status, table.dueAt),
  ]
);

export type ScheduledFollowUpRecord = typeof scheduledFollowUpsTable.$inferSelect;
export type ScheduledFollowUpInsert = typeof scheduledFollowUpsTable.$inferInsert;

import { pgTable, text, uuid, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { WakeSignalPayload } from "../../ask/wake-on-respond";

/**
 * wake_pending table — undelivered Ask wake events for in-conversation drain.
 *
 * Implements the v0 short-term bridge from mt#1519 §5 (catalog) / mt#1661 (this task).
 *
 * Producer side: `PersistentWakeSignalSink` writes one row per `quality.review` Ask
 * `responded` transition. Consumer side: `enrichWakeResponse` MCP middleware drains
 * undelivered rows for the calling session at every allowlisted tool call.
 *
 * **v0 scope deliberately keys on `parent_session_id` only** — no `agent_id` column.
 * Cross-session and agent-handoff delivery require the InterfaceBinding model
 * designed in mt#1506; v0 covers only the unambiguous case where the calling
 * tool's args directly name the session/task.
 *
 * Conventions (mirroring asks-schema and pr-watch-schema):
 * - UUID PK with defaultRandom()
 * - No FK constraints — parent_session_id and ask_id are plain text refs
 * - jsonb for the full WakeSignalPayload (operators reading the table see the
 *   payload shape without joining to the asks table)
 * - withTimezone on all timestamps
 * - snake_case column names, camelCase TypeScript identifiers
 *
 * Retirement: v0 retires when mt#1506's InterfaceBinding model lands and is
 * integrated with WakeSignalSink. mt#1001 (mesh push) is the long-term Class A
 * subscriber that may obviate this table entirely.
 */
export const wakePendingTable = pgTable(
  "wake_pending",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** Minsky session UUID this wake is addressed to (Ask.parentSessionId). */
    parentSessionId: text("parent_session_id").notNull(),

    /** Ask ID that produced this wake event. */
    askId: text("ask_id").notNull(),

    /** Full WakeSignalPayload as JSON (the seven canonical fields). */
    payloadJson: jsonb("payload_json").$type<WakeSignalPayload>().notNull(),

    /** When the producer side wrote this row (reconciler dispatch time). */
    emittedAt: timestamp("emitted_at", { withTimezone: true }).notNull().defaultNow(),

    /**
     * When the consumer side delivered this row to the calling agent. NULL while
     * undelivered. The partial index below filters on this column to keep drain
     * queries fast.
     */
    drainedAt: timestamp("drained_at", { withTimezone: true }),

    /**
     * The MCP tool name on which this wake was delivered. Useful for telemetry —
     * shows which tool calls actually deliver wakes vs which never do.
     */
    drainedForTool: text("drained_for_tool"),
  },
  (table) => ({
    /**
     * Partial index on undelivered rows. The middleware's hot path is
     * "find all undelivered wakes for session S" — this index keeps it O(matches)
     * regardless of total table size.
     */
    undeliveredByParentSession: index("wake_pending_undelivered")
      .on(table.parentSessionId)
      .where(sql`${table.drainedAt} IS NULL`),
  })
);

export type WakePendingRecord = typeof wakePendingTable.$inferSelect;
export type WakePendingInsert = typeof wakePendingTable.$inferInsert;

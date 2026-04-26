import {
  pgTable,
  text,
  uuid,
  timestamp,
  jsonb,
  integer,
  boolean,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { PrWatchEvent } from "../../pr-watch/types";

/**
 * pr_watches table — subscription records for the operator PR-state watcher.
 *
 * Implements the `pr_watches` table for mt#1294 (parent mt#1234).
 * The `event` column is constrained via CHECK so the DB rejects unknown
 * event values even if the application layer passes them through.
 *
 * Conventions (consistent with asks schema from mt#1236):
 * - UUID PK with defaultRandom()
 * - No FK constraints — watcher_id is a plain text ref per project convention
 * - jsonb for structured columns (last_seen, metadata)
 * - withTimezone on all timestamps
 * - snake_case column names, camelCase TypeScript identifiers
 */

/** Allowed PrWatchEvent values — must mirror src/domain/pr-watch/types.ts PrWatchEvent */
const PR_WATCH_EVENT_VALUES = [
  "merged",
  "review-posted",
  "check-status-changed",
] as const satisfies readonly PrWatchEvent[];

/** SQL expression for the event CHECK constraint */
const eventCheckSql = sql.raw(
  `event IN (${PR_WATCH_EVENT_VALUES.map((v) => `'${v}'`).join(", ")})`
);

export const prWatchesTable = pgTable(
  "pr_watches",
  {
    // -------------------------------------------------------------------------
    // Identity
    // -------------------------------------------------------------------------
    id: uuid("id").defaultRandom().primaryKey(),

    // -------------------------------------------------------------------------
    // Target PR
    // -------------------------------------------------------------------------

    /** GitHub repository owner. */
    prOwner: text("pr_owner").notNull(),

    /** GitHub repository name. */
    prRepo: text("pr_repo").notNull(),

    /** Pull request number within the repository. */
    prNumber: integer("pr_number").notNull(),

    // -------------------------------------------------------------------------
    // Watch specification
    // -------------------------------------------------------------------------

    /** Which PR event to watch for (CHECK constraint enforced). */
    event: text("event").notNull(),

    /**
     * One-shot (false) vs persistent (true) watch.
     * When false, the watch is considered consumed once triggered.
     */
    keep: boolean("keep").notNull(),

    /** Operator identity in `{kind}:{scope}:{id}` format. */
    watcherId: text("watcher_id").notNull(),

    // -------------------------------------------------------------------------
    // Cursor / state
    // -------------------------------------------------------------------------

    /**
     * Event-specific deduplication cursor (jsonb).
     * Null until the first reconciler pass; shape is event-dependent.
     */
    lastSeen: jsonb("last_seen").$type<Record<string, unknown>>(),

    // -------------------------------------------------------------------------
    // Timestamps
    // -------------------------------------------------------------------------

    /** When this watch was registered. */
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),

    /**
     * When the predicate last matched.
     * Null on active (not-yet-triggered) watches.
     */
    triggeredAt: timestamp("triggered_at", { withTimezone: true }),

    // -------------------------------------------------------------------------
    // Extensibility
    // -------------------------------------------------------------------------

    /**
     * Arbitrary metadata for transport adapters and future extensions.
     * Default `{}` ensures the column is never NULL.
     */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (table) => ({
    // Composite index for the most common lookup: find watches for a given PR
    byPr: index("idx_pr_watches_pr").on(table.prOwner, table.prRepo, table.prNumber),

    // Index for querying watches by trigger time (e.g., sweeper cleanup)
    byTriggeredAt: index("idx_pr_watches_triggered_at").on(table.triggeredAt),

    // Enum guard: reject unknown event values at DB level
    eventCheck: check("chk_pr_watches_event", eventCheckSql),
  })
);

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export type PrWatchRecord = typeof prWatchesTable.$inferSelect;
export type PrWatchInsert = typeof prWatchesTable.$inferInsert;

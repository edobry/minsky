import { pgTable, text, uuid, timestamp, jsonb, index, pgEnum } from "drizzle-orm/pg-core";

/**
 * System events table — unified event substrate for the cockpit activity feed.
 *
 * Persists actionable events emitted by the Minsky system (in-process) and
 * remote producers (adoption sweeper, reviewer service) via the `events.emit`
 * MCP tool. The table is append-only; no updates or deletes.
 *
 * v1 event types are deliberately narrow: only events where the operator
 * needs to know in order to take action. Informational events are added later
 * when a concrete operator workflow requires them.
 *
 * @see mt#2092 — Event log Phase 1a (this task)
 * @see RFC: https://www.notion.so/36a937f03cb481289df2ee5d2fa932d4
 */

/** System event type enum — exactly 4 actionable values per mt#2092 spec */
export const SYSTEM_EVENT_TYPE_VALUES = [
  "ask.created",
  "task.auto_created",
  "pr.review_posted",
  "subagent.failed",
] as const;

export type SystemEventType = (typeof SYSTEM_EVENT_TYPE_VALUES)[number];

export const systemEventTypeEnum = pgEnum("system_event_type", SYSTEM_EVENT_TYPE_VALUES);

/**
 * system_events table.
 *
 * Column groupings:
 *   - Identity: id, eventType
 *   - Payload: payload (JSONB)
 *   - Context: actor, relatedTaskId, relatedSessionId
 *   - Timestamp: createdAt
 */
export const systemEventsTable = pgTable(
  "system_events",
  {
    // -------------------------------------------------------------------------
    // Identity
    // -------------------------------------------------------------------------

    /** Surrogate primary key. */
    id: uuid("id").defaultRandom().primaryKey(),

    /**
     * Event type enum — exactly the 4 values defined in SYSTEM_EVENT_TYPE_VALUES.
     * Enforced at DB level via pgEnum.
     */
    eventType: systemEventTypeEnum("event_type").notNull(),

    // -------------------------------------------------------------------------
    // Payload
    // -------------------------------------------------------------------------

    /**
     * Structured event payload — shape varies by event type.
     *
     * ask.created:        { askId, kind, title, requestor, parentTaskId? }
     * task.auto_created:  { taskId, title, createdBy, sourceRule }
     * pr.review_posted:   { prUrl, prNumber, reviewer, state, taskId? }
     * subagent.failed:    { outcome, taskId, sessionId?, errorSummary? }
     */
    payload: jsonb("payload").notNull(),

    // -------------------------------------------------------------------------
    // Context
    // -------------------------------------------------------------------------

    /**
     * Who emitted the event, in `{kind}:{scope}:{id}` AgentId format or
     * a human-readable identifier (e.g., "adoption-sweeper", "operator").
     * Nullable — not all events have a known actor at emission time.
     */
    actor: text("actor"),

    /**
     * Related Minsky task ID (e.g. "mt#123"). Nullable — some events are
     * session-scoped or system-scoped without a specific task.
     */
    relatedTaskId: text("related_task_id"),

    /**
     * Related Minsky session ID. Nullable — some events are task-scoped or
     * system-scoped without a specific session.
     */
    relatedSessionId: text("related_session_id"),

    // -------------------------------------------------------------------------
    // Timestamp
    // -------------------------------------------------------------------------

    /** When the event was emitted. */
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Event type filtering (cockpit activity feed type filter)
    index("idx_system_events_event_type").on(table.eventType),

    // Chronological queries — DESC for most-recent-first reads
    index("idx_system_events_created_at").on(table.createdAt),

    // Related task lookup — partial index only on non-null values
    index("idx_system_events_related_task_id").on(table.relatedTaskId),
  ]
);

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export type SystemEventRecord = typeof systemEventsTable.$inferSelect;
export type SystemEventInsert = typeof systemEventsTable.$inferInsert;

/** Domain-facing system event shape (timestamps as ISO-8601 strings). */
export interface SystemEvent {
  id: string;
  eventType: SystemEventType;
  payload: Record<string, unknown>;
  actor?: string;
  relatedTaskId?: string;
  relatedSessionId?: string;
  createdAt: string;
}

/** Input for creating a new system event. */
export interface SystemEventInput {
  eventType: SystemEventType;
  payload: Record<string, unknown>;
  actor?: string;
  relatedTaskId?: string;
  relatedSessionId?: string;
}

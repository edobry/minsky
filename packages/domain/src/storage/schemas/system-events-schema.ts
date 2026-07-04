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

/**
 * System event type enum.
 *
 * Write-scope is deliberately WIDER than the activity feed's default read-scope
 * (mt#2340). The feed defaults to the `actionable` category; the broader
 * `informational` types are persisted unconditionally so the Phase 2
 * attention-allocation noticer (mt#1034) has populated trajectory history to
 * consume when it lands, rather than starting cold. Which category a type
 * belongs to is read-side classification (see `eventCategory` below) — it is
 * NOT stored per-row, mirroring the RFC's "no `source` column; derive from the
 * type" decision.
 *
 * Actionability is a property of the TYPE, not the instance. Where a payload
 * subtype would change actionability (a failed vs. successful deploy), SPLIT
 * the event type rather than branching the classifier on payload — keeping the
 * `eventCategory` map a pure type→category lookup.
 */
export const SYSTEM_EVENT_TYPE_VALUES = [
  // --- actionable (mt#2092 / mt#2147) — operator must know to take action ---
  "ask.created",
  "task.auto_created",
  "pr.review_posted",
  "subagent.failed",
  "embeddings.provider_degraded",
  // --- informational / trajectory (mt#2340) — discoverable on the operator's
  //     own schedule; primary consumer is the Phase 2 noticer ---
  "task.status_changed",
  "pr.merged",
  "subagent.completed",
  "session.started",
  // mt#2489 (plant board v2.1) — DB-resident domain events
  "memory.created",
  "ask.answered",
  // mt#2537 (plant board v2.1 — hard cross-process bridges) — informational,
  // each backed by a non-DB-resident source bridged into this table. See the
  // payload-shape doc block below for each type's non-stub invocation path
  // (CLAUDE.md "Invocation path required for event/poll mechanisms").
  "changeset.created",
  "hook.fired",
  "mcp.disconnect",
  "retrospective.fired",
  "deploy.build",
  "deploy.smoke",
  "deploy.live",
  "deploy.fail",
] as const;

/**
 * Payload shapes for the mt#2489 plant-board v2.1 event types. The table's
 * `payload` JSONB is loosely typed as `Record<string, unknown>`; these are the
 * concrete shapes the producers emit (see `system-event-emit.ts`):
 *
 *   - `memory.created` → `{ memoryId: string; memoryType: string; scope: string }`
 *       emitted by the `memory.create` command after the record is persisted.
 *   - `ask.answered`   → `{ askId: string; responder: string | null }`
 *       emitted by the `asks.respond` command after the Ask is answered + closed.
 *
 * Payload shapes for the mt#2537 plant-board v2.1 "hard bridge" event types
 * (each sourced from a non-DB-resident producer — see the cited emit site for
 * the concrete non-stub invocation path):
 *
 *   - `changeset.created` → `{ prNumber: number; taskId?: string; title?: string }`
 *       emitted from the `session_pr_create` seam
 *       (`packages/domain/src/session/session-pr-operations.ts`), mirroring the
 *       `pr.merged` emit in `session-merge-operations.ts` (mt#2487).
 *   - `hook.fired` → `{ hook: string; decision: "blocked" | "overridden"; subject?: string }`
 *       emitted from the shared `writeOutput()` deny path in
 *       `.claude/hooks/types.ts` (mt#2537). v1 covers `decision: "blocked"`
 *       only — "overridden" audit lines are per-hook free-text stdout writes
 *       with no shared choke point and are deferred (see PR body).
 *   - `mcp.disconnect` → `{ cause: string; serverName: string; uptimeMs?: number; processRole?: string }`
 *       emitted by a boot-time sweep of the disconnect-tracker JSONL
 *       (`src/mcp/disconnect-tracker.ts`) run from `src/mcp/server.ts`,
 *       HWM-gated by timestamp so repeated sweeps don't double-emit.
 *   - `retrospective.fired` → `{ note: string; taskId?: string }`
 *       emitted via the CLI path (`minsky events emit retrospective.fired`)
 *       from the `/retrospective` skill's structural-fix step.
 *   - `deploy.build` / `deploy.smoke` / `deploy.live` / `deploy.fail` →
 *       `{ phase: "build" | "smoke" | "live" | "fail"; service?: string; status: string }`
 *       — v1 emits `deploy.live` / `deploy.fail` from the
 *       `deployment_wait-for-latest` observation path
 *       (`packages/domain/src/deployment/`); `deploy.build` / `deploy.smoke`
 *       have no clean v1 seam (the platform-neutral wrapper observes only the
 *       terminal deployment record, not per-phase build/smoke callbacks) and
 *       are deferred — see PR body.
 */

export type SystemEventType = (typeof SYSTEM_EVENT_TYPE_VALUES)[number];

export const systemEventTypeEnum = pgEnum("system_event_type", SYSTEM_EVENT_TYPE_VALUES);

// ---------------------------------------------------------------------------
// Event category — read-side classification (mt#2340)
// ---------------------------------------------------------------------------

/** Feed-filter categories. `actionable` is the activity feed's default view. */
export const EVENT_CATEGORY_VALUES = ["actionable", "informational"] as const;

export type EventCategory = (typeof EVENT_CATEGORY_VALUES)[number];

/**
 * The single source of truth mapping each event type to its category.
 *
 * `satisfies Record<SystemEventType, EventCategory>` gives compile-time
 * exhaustiveness: adding a value to `SYSTEM_EVENT_TYPE_VALUES` without a
 * category entry fails the typecheck. `enum-drift.test.ts` asserts the same
 * invariant at runtime as a second guard.
 *
 * Producers emit a TYPE; they never set a category. The category is resolved
 * read-side (query filter, cockpit feed) from this map.
 */
export const eventCategory = {
  "ask.created": "actionable",
  "task.auto_created": "actionable",
  "pr.review_posted": "actionable",
  "subagent.failed": "actionable",
  "embeddings.provider_degraded": "actionable",
  "task.status_changed": "informational",
  "pr.merged": "informational",
  "subagent.completed": "informational",
  "session.started": "informational",
  "memory.created": "informational",
  "ask.answered": "informational",
  "changeset.created": "informational",
  "hook.fired": "informational",
  "mcp.disconnect": "informational",
  "retrospective.fired": "informational",
  "deploy.build": "informational",
  "deploy.smoke": "informational",
  "deploy.live": "informational",
  "deploy.fail": "informational",
} satisfies Record<SystemEventType, EventCategory>;

/** Return all event types belonging to a given category (for `WHERE IN` filters). */
export function eventTypesForCategory(category: EventCategory): SystemEventType[] {
  return SYSTEM_EVENT_TYPE_VALUES.filter((t) => eventCategory[t] === category);
}

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
     * Event type enum — exactly the values defined in SYSTEM_EVENT_TYPE_VALUES.
     * Enforced at DB level via pgEnum.
     */
    eventType: systemEventTypeEnum("event_type").notNull(),

    // -------------------------------------------------------------------------
    // Payload
    // -------------------------------------------------------------------------

    /**
     * Structured event payload — shape varies by event type.
     *
     * ask.created:                    { askId, kind, title, requestor, parentTaskId? }
     * task.auto_created:              { taskId, title, createdBy, sourceRule }
     * pr.review_posted:               { prUrl, prNumber, reviewer, state, taskId? }
     * subagent.failed:                { outcome, taskId, sessionId?, errorSummary? }
     * embeddings.provider_degraded:   { provider, errorCode, status, failureCount, degradedReason }
     * task.status_changed:            { taskId, previousStatus, newStatus }
     * pr.merged:                      { prUrl, prNumber, taskId? }
     * subagent.completed:             { agentType, taskId, outcome? }
     * session.started:                { sessionId, taskId? }
     * changeset.created:              { prNumber, taskId?, title? }
     * hook.fired:                     { hook, decision, subject? }
     * mcp.disconnect:                 { cause, serverName, uptimeMs?, processRole? }
     * retrospective.fired:            { note, taskId? }
     * deploy.build/smoke/live/fail:   { phase, service?, status }
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

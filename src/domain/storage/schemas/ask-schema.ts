import { pgTable, text, uuid, timestamp, jsonb, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { AskKind, AskState, AskOption, ContextRef } from "../../ask/types";

/**
 * Asks table — the unified domain entity for all human-in-the-loop mechanisms.
 *
 * Implements the `asks` table from ADR-006 §The Ask entity.
 * All seven AskKind values and eight AskState values are enforced via CHECK
 * constraints so the DB rejects invalid enum values even if the application
 * layer passes them through.
 *
 * Conventions followed (consistent with task-relationships and provenance):
 * - UUID PK with defaultRandom()
 * - No FK constraints — taskId/sessionId are plain text refs per project convention
 * - jsonb for structured/array columns (options, contextRefs, response, metadata)
 * - withTimezone on all timestamps
 * - snake_case column names, camelCase TypeScript identifiers
 */

/** Allowed AskKind values — must mirror src/domain/ask/types.ts AskKind */
const ASK_KIND_VALUES = [
  "capability.escalate",
  "information.retrieve",
  "authorization.approve",
  "direction.decide",
  "coordination.notify",
  "quality.review",
  "stuck.unblock",
] as const satisfies readonly AskKind[];

/** Allowed AskState values — must mirror src/domain/ask/types.ts AskState */
const ASK_STATE_VALUES = [
  "detected",
  "classified",
  "routed",
  "suspended",
  "responded",
  "closed",
  "cancelled",
  "expired",
] as const satisfies readonly AskState[];

/** SQL expression for the kind CHECK constraint */
const kindCheckSql = sql.raw(`kind IN (${ASK_KIND_VALUES.map((v) => `'${v}'`).join(", ")})`);

/** SQL expression for the state CHECK constraint */
const stateCheckSql = sql.raw(`state IN (${ASK_STATE_VALUES.map((v) => `'${v}'`).join(", ")})`);

export const asksTable = pgTable(
  "asks",
  {
    // -------------------------------------------------------------------------
    // Identity
    // -------------------------------------------------------------------------
    id: uuid("id").defaultRandom().primaryKey(),

    /** Seven-kind taxonomy label (CHECK constraint enforced). */
    kind: text("kind").notNull(),

    /** Version tag of the classifier that assigned `kind`. */
    classifierVersion: text("classifier_version").notNull(),

    // -------------------------------------------------------------------------
    // Lifecycle state
    // -------------------------------------------------------------------------

    /** Current lifecycle state (CHECK constraint enforced). */
    state: text("state").notNull(),

    // -------------------------------------------------------------------------
    // Participants
    // -------------------------------------------------------------------------

    /** Who is asking, in `{kind}:{scope}:{id}` AgentId format. */
    requestor: text("requestor").notNull(),

    /** Resolved routing target (AgentId, "operator", or "policy"). */
    routingTarget: text("routing_target"),

    // -------------------------------------------------------------------------
    // Context / payload
    // -------------------------------------------------------------------------

    /** Parent task ID (e.g. "mt#123"). Nullable — some asks are session-scoped. */
    parentTaskId: text("parent_task_id"),

    /** Parent session UUID when the Ask originated in an active session. */
    parentSessionId: text("parent_session_id"),

    /** Short summary line used for list rendering and notifications. */
    title: text("title").notNull(),

    /** The full ask body — what the requestor needs resolved. */
    question: text("question").notNull(),

    /** Structured decision frame (AskOption[]). Present for decision-like kinds. */
    options: jsonb("options").$type<AskOption[]>(),

    /** Pointers to contextual artifacts the responder may need (ContextRef[]). */
    contextRefs: jsonb("context_refs").$type<ContextRef[]>(),

    // -------------------------------------------------------------------------
    // Response
    // -------------------------------------------------------------------------

    /**
     * The resolved response payload.
     * Shape: { responder, payload, attentionCost? }
     */
    response: jsonb("response").$type<{
      responder: string;
      payload: unknown;
      attentionCost?: unknown;
    }>(),

    // -------------------------------------------------------------------------
    // Timestamps
    // -------------------------------------------------------------------------

    /** Soft deadline; when exceeded the Ask transitions to "expired". */
    deadline: timestamp("deadline", { withTimezone: true }),

    /** When the Ask was first detected. */
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),

    /** When a routing target was selected. */
    routedAt: timestamp("routed_at", { withTimezone: true }),

    /** When the Ask entered "suspended" state. */
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),

    /** When a response was received. */
    respondedAt: timestamp("responded_at", { withTimezone: true }),

    /** When the Ask reached a terminal state. */
    closedAt: timestamp("closed_at", { withTimezone: true }),

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
    // Composite index for the most common query pattern: filter by state + kind
    byStateKind: index("idx_asks_state_kind").on(table.state, table.kind),

    // Index for fetching all asks belonging to a task
    byParentTask: index("idx_asks_parent_task_id").on(table.parentTaskId),

    // Index for fetching all asks belonging to a session
    byParentSession: index("idx_asks_parent_session_id").on(table.parentSessionId),

    // Enum guard: reject unknown kind values at DB level
    kindCheck: check("chk_asks_kind", kindCheckSql),

    // Enum guard: reject unknown state values at DB level
    stateCheck: check("chk_asks_state", stateCheckSql),
  })
);

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export type AskRecord = typeof asksTable.$inferSelect;
export type AskInsert = typeof asksTable.$inferInsert;

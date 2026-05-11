import {
  pgTable,
  text,
  uuid,
  timestamp,
  integer,
  boolean,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";

/**
 * Subagent invocations table — persists execution history for subagent dispatches.
 *
 * Each row records one subagent invocation as dispatched by a parent agent session.
 * Captures dispatch parameters, timing, outcome, and workspace state at end of run.
 *
 * The `agentSessionId` column joins to `agent_transcripts.agent_session_id` (mt#1313)
 * and `agent_spawns.agent_session_id` (mt#1324). The type is plain `text` to align
 * with those tables (both use `text` for agent session IDs, not UUID).
 *
 * @see mt#1005 — Persist subagent execution history records linked to tasks
 * @see mt#1735 — Foundation subtask (schema + migration)
 * @see mt#1313 — Transcript search: harness-agnostic ingestion
 * @see mt#1324 — Foundation schema migration
 */

/** Outcome enum — exactly 6 values per mt#1005 spec */
export const SUBAGENT_INVOCATION_OUTCOME_VALUES = [
  "completed-with-pr",
  "committed-no-pr",
  "partial-committed-handoff-written",
  "partial-uncommitted-no-handoff",
  "crashed-no-output",
  "rate-limited",
] as const;

export type SubagentInvocationOutcome = (typeof SUBAGENT_INVOCATION_OUTCOME_VALUES)[number];

export const subagentInvocationOutcomeEnum = pgEnum(
  "subagent_invocation_outcome",
  SUBAGENT_INVOCATION_OUTCOME_VALUES
);

/**
 * subagent_invocations table.
 *
 * Column groupings mirror the mt#1005 schema spec section:
 *   - Identity: id, taskId, sessionId, agentSessionId, parentSessionId, parentTaskId, subagentSessionId
 *   - Dispatch params: agentType, suggestedModel, actualModel
 *   - Timing: startedAt, endedAt, durationMs
 *   - Metrics: toolUseCount, totalTokens
 *   - Outcome: outcome, errorSummary, summary
 *   - Workspace state: prUrl, lastCommitHash, handoffWritten
 */
export const subagentInvocationsTable = pgTable(
  "subagent_invocations",
  {
    // -------------------------------------------------------------------------
    // Identity
    // -------------------------------------------------------------------------

    /** Surrogate primary key. */
    id: uuid("id").defaultRandom().primaryKey(),

    /** Minsky task ID this invocation is associated with (e.g., "mt#1735"). */
    taskId: text("task_id").notNull(),

    /** Minsky session ID of the parent/calling session. */
    sessionId: text("session_id"),

    /**
     * Harness-native agent session ID of the subagent.
     * Joins to agent_transcripts.agent_session_id and agent_spawns.agent_session_id.
     * Type is text (not UUID) to align with those tables.
     */
    agentSessionId: text("agent_session_id"),

    /** Minsky session ID of the parent agent. */
    parentSessionId: text("parent_session_id"),

    /** Minsky task ID of the parent agent (may differ from taskId for decomposed work). */
    parentTaskId: text("parent_task_id"),

    /** Minsky session ID assigned to the subagent's workspace. */
    subagentSessionId: text("subagent_session_id"),

    // -------------------------------------------------------------------------
    // Dispatch params
    // -------------------------------------------------------------------------

    /** Agent type passed to session_generate_prompt (e.g., "refactorer", "auditor"). */
    agentType: text("agent_type").notNull(),

    /** Suggested model at dispatch time (e.g., "sonnet", "opus"). */
    suggestedModel: text("suggested_model"),

    /** Actual model the subagent ran on (recorded from transcript if available). */
    actualModel: text("actual_model"),

    // -------------------------------------------------------------------------
    // Timing
    // -------------------------------------------------------------------------

    /** When the subagent dispatch was initiated. */
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),

    /** When the subagent returned (or was declared timed out / crashed). */
    endedAt: timestamp("ended_at", { withTimezone: true }),

    /** Wall-clock duration in milliseconds (null when endedAt not yet recorded). */
    durationMs: integer("duration_ms"),

    // -------------------------------------------------------------------------
    // Metrics
    // -------------------------------------------------------------------------

    /** Number of tool calls the subagent made (from transcript if available). */
    toolUseCount: integer("tool_use_count"),

    /** Total token count for the subagent session (from transcript if available). */
    totalTokens: integer("total_tokens"),

    // -------------------------------------------------------------------------
    // Outcome
    // -------------------------------------------------------------------------

    /**
     * Outcome classification using the 6-class enum.
     * Exactly the 6 values defined in SUBAGENT_INVOCATION_OUTCOME_VALUES.
     */
    outcome: subagentInvocationOutcomeEnum("outcome").notNull(),

    /** Brief summary of any error that occurred, if applicable. */
    errorSummary: text("error_summary"),

    /** Narrative summary of what the subagent accomplished. */
    summary: text("summary"),

    // -------------------------------------------------------------------------
    // Workspace state
    // -------------------------------------------------------------------------

    /** URL of the PR created by the subagent, if any. */
    prUrl: text("pr_url"),

    /** Last git commit hash in the subagent's session workspace at end of run. */
    lastCommitHash: text("last_commit_hash"),

    /** Whether the subagent wrote a handoff.md file before exiting. */
    handoffWritten: boolean("handoff_written"),
  },
  (table) => [
    // Primary lookup: all invocations for a given task
    index("idx_subagent_invocations_task_id").on(table.taskId),

    // Join to agent_transcripts / agent_spawns
    index("idx_subagent_invocations_agent_session_id").on(table.agentSessionId),

    // Chronological queries and time-range scans
    index("idx_subagent_invocations_started_at").on(table.startedAt),

    // Outcome-class aggregation and filtering
    index("idx_subagent_invocations_outcome").on(table.outcome),
  ]
);

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

export type SubagentInvocationRecord = typeof subagentInvocationsTable.$inferSelect;
export type SubagentInvocationInsert = typeof subagentInvocationsTable.$inferInsert;

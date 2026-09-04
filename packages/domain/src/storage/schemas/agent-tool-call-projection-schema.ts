import { pgTable, text, integer, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentTranscriptsTable } from "./agent-transcripts-schema";

/**
 * Tool-call projection table — a cheap, ordered view of tool-call *streams*,
 * derived from `agent_transcript_turns.tool_calls` (jsonb holding full
 * `tool_use` blocks, including entire file bodies for Write/Edit inputs — so
 * any cross-window scan over the raw column pulls megabytes per session).
 *
 * One row per `tool_use` content block extracted from a turn's `tool_calls`
 * array, in original array order (`ordinal`). This is the shared, cheap read
 * surface the EngProd miner (mt#3330) and mt#1120's supervision analysis both
 * need: an ordered tool-name stream per session over a trailing time window,
 * without ever reading the raw jsonb column.
 *
 * `arg_fingerprint` is a stable short hash of the (normalized) tool-call
 * input — NEVER the raw arguments. Storing raw arguments here would
 * duplicate the megabyte-scale Write/Edit file bodies already held in
 * `agent_transcript_turns.tool_calls`, plus risk re-surfacing any secrets a
 * transcript may carry (see `credential-scrubber.ts`). See
 * `tool-call-projection-fields.ts` for the hash + tool-name-parsing logic.
 *
 * Note for readers auditing "what's NOT captured here": `thinking` content
 * blocks are never present in transcripts at all (mt#3276), so there is no
 * thinking-text leakage risk in this table by construction — only
 * `tool_use` blocks are ever projected. Projection completeness also
 * inherits the transcript pipeline's own gaps: a quarantined session
 * (mt#3278, `agent_transcripts.ingest_quarantined_at`) never gets its turns
 * materialized in the first place, so it contributes no projection rows
 * either — this table is not a separate source of truth about ingest health.
 *
 * @see mt#3329 — this table
 * @see mt#3327 — parent umbrella (EngProd miner RFC, Phase 1)
 * @see agent-transcript-turns-schema.ts — source table (`tool_calls` jsonb)
 * @see agent-spawns-schema.ts — sibling derived-table precedent (same
 *   post-pass-pipeline-over-turns architecture this table follows)
 */
export const agentToolCallProjectionTable = pgTable(
  "agent_tool_call_projection",
  {
    agentSessionId: text("agent_session_id")
      .notNull()
      .references(() => agentTranscriptsTable.agentSessionId),

    turnIndex: integer("turn_index").notNull(),

    /** Position of this tool_use block within the turn's tool_calls array (0-based). */
    ordinal: integer("ordinal").notNull(),

    /** Bare tool name, e.g. "session_edit_file", "Bash", "Agent" (server prefix stripped). */
    toolName: text("tool_name").notNull(),

    /** MCP server name parsed from `mcp__<server>__<name>`; null for non-MCP tools. */
    server: text("server"),

    /** Stable short hash of the (normalized) tool-call input — never the raw arguments. */
    argFingerprint: text("arg_fingerprint").notNull(),

    /** Turn timestamp (endedAt ?? startedAt, mirroring agent_transcript_turns). */
    timestamp: timestamp("timestamp", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.agentSessionId, table.turnIndex, table.ordinal] }),
    // Supports the trailing-time-window scan the EngProd miner / mt#1120
    // supervision analysis both need ("ordered tool-name stream per session
    // over a trailing time window") without ever touching
    // agent_transcript_turns's jsonb column — see mt#3329 AT3 (EXPLAIN-checked
    // window query touches only this table and its indexes).
    index("idx_agent_tool_call_projection_timestamp").on(table.timestamp),

    /**
     * The cockpit Messages page's sender lookup (mt#4874).
     *
     * The index above is deliberately on `timestamp` ALONE — its own comment
     * says it exists for a "trailing-time-window scan", not a tool lookup. So a
     * newest-first query for ONE tool name walks it backwards and discards
     * everything else, and the cost is a function of how recently that tool was
     * last used rather than of how many rows match. That is not a slow-growing
     * concern: measured against production, the newest-50 `SendMessage` query
     * discarded 34,777 rows in 134 ms on 2026-09-01 and 36,508 rows in
     * **2,772 ms** on 2026-09-02 — a 20x regression in one day, from nothing
     * but a quiet period.
     *
     * PARTIAL because the predicate is true for almost nothing and does not
     * grow with the table: 348 of ~409,000 rows. Ordered DESC so the newest-
     * first read is a plain forward walk of a ~348-entry index.
     */
    index("idx_agent_tool_call_projection_send_message")
      .on(table.timestamp.desc())
      .where(sql`${table.toolName} = 'SendMessage'`),
  ]
);

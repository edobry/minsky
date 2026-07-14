import { pgTable, text, integer, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
import { agentTranscriptsTable } from "./agent-transcripts-schema";

/**
 * Agent spawns table — edges between parent and child agent sessions.
 *
 * When a parent agent session invokes a subagent via the Agent tool, a row is
 * inserted here linking the parent's turn (parent_agent_session_id, parent_turn_index)
 * to the child's session ID. The child_agent_session_id column is nullable and
 * backfilled when the child transcript is ingested (or on a subsequent sweep pass).
 *
 * Joining agent_spawns to agent_transcripts on child_agent_session_id yields the
 * full subagent conversation. Joining on parent_agent_session_id + parent_turn_index
 * yields the spawn invocation context in the parent.
 *
 * @see mt#1313 — Transcript search: harness-agnostic ingestion (§Subagent dedup)
 * @see mt#1324 — Foundation schema migration
 */
export const agentSpawnsTable = pgTable(
  "agent_spawns",
  {
    parentAgentSessionId: text("parent_agent_session_id")
      .notNull()
      .references(() => agentTranscriptsTable.agentSessionId),

    parentTurnIndex: integer("parent_turn_index").notNull(),

    // Nullable until the child transcript is ingested and linked back
    childAgentSessionId: text("child_agent_session_id"),

    // Spawn characteristics
    spawnType: text("spawn_type"), // 'foreground' | 'background'
    agentKind: text("agent_kind"), // 'general-purpose' | 'Explore' | 'refactorer' | ...

    // When the spawn was initiated (from parent JSONL timestamp)
    spawnedAt: timestamp("spawned_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.parentAgentSessionId, table.parentTurnIndex] }),
    // mt#2767 (latency follow-up) — the composite PK above only covers
    // lookups keyed by parentAgentSessionId; both the context-inspector
    // widget's tier-3 subagent-descriptor lookup AND the unified run-list
    // merge's subagent-classification query filter on
    // `child_agent_session_id IN (...)` alone, which the PK cannot serve —
    // a full-table scan on every poll. Contributed to context-inspector's
    // own live-measured 2.93s response (2026-07-14), well above the
    // pre-merge baseline's 0.33s warm.
    index("idx_agent_spawns_child_agent_session_id").on(table.childAgentSessionId),
  ]
);

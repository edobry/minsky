import { pgTable, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agentTranscriptsTable } from "./agent-transcripts-schema";

/**
 * Agent spawns table — edges between parent and child agent sessions.
 *
 * When a parent agent session invokes a subagent via the Agent tool, a row is
 * inserted here linking the parent's Agent tool call to the child's session ID.
 * The child_agent_session_id column is nullable and backfilled when the child
 * transcript is ingested (or on a subsequent sweep pass).
 *
 * Joining agent_spawns to agent_transcripts on child_agent_session_id yields the
 * full subagent conversation. Joining on parent_tool_use_id yields the spawn
 * invocation context in the parent — see the identity note below for why that,
 * and not (parent_agent_session_id, parent_turn_index), is the join key.
 *
 * ## Row identity: parent_tool_use_id, not parent_turn_index (mt#3692)
 *
 * `parent_turn_index` indexes `agent_transcript_turns`, which is a DERIVED,
 * re-materializable projection of the raw transcript: `extractTurns()` emits one
 * row per (user, assistant) PAIR, so the index depends on both the pairing
 * algorithm and the transcript's current contents. Two consequences made it
 * unusable as this table's identity:
 *
 *   1. **It does not address anything a reader holds.** The cockpit conversation
 *      surface indexes the RAW transcript array — one entry per JSONL line —
 *      via `assembleSessionContextSnapshot`. The two index spaces diverge by
 *      roughly the pairing ratio (measured 2026-08-04: one session had 10,957
 *      array lines against 4,132 extracted turns), so a join across them lands
 *      on an unrelated turn rather than failing loudly.
 *   2. **It is coarser than a spawn.** One turn can carry several Agent tool
 *      calls — parallel dispatch is idiomatic — so a turn-granular primary key
 *      could record only the first. 85 turns in the corpus carried 2+ calls,
 *      one carried 8.
 *
 * `parent_tool_use_id` is the harness-assigned `tool_use` id of the Agent call
 * itself. It is present on every Agent call in the corpus and independent of any
 * derivation, so it survives re-extraction and ADR-025's planned re-point of the
 * snapshot assembler onto turn rows (mt#2580).
 *
 * **The id is unique within a conversation, NOT across the corpus** — hence the
 * composite `(parent_agent_session_id, parent_tool_use_id)` key rather than a
 * bare unique index on the id. Measured 2026-08-04: 43 ids appeared in more than
 * one `agent_transcripts` row, because a dispatching Agent call is replayed into
 * the child's own transcript, so the same id is legitimately present in both the
 * parent's and the child's turn rows. A corpus-wide unique index would have
 * failed at creation and halted the migration chain (the mem#636 failure class).
 *
 * `parent_turn_index` is retained: it still records WHERE in the derived turn
 * projection the spawn sits, which the extraction sweep uses to find its work.
 * It is no longer an identity, hence the plain (non-unique) index.
 *
 * The table deliberately has NO primary key, and `parent_tool_use_id` is
 * nullable, because two classes of pre-mt#3692 row cannot carry one: 179 rows
 * whose parent turn no longer holds a matching Agent call, and 111 rows that are
 * duplicate recordings of a spawn already backfilled under a lower turn index
 * (both classes are orphans of past re-derivations, which upsert but never
 * delete). Postgres permits multiple NULLs under a unique index, so those rows
 * coexist without colliding; they resolve no join and therefore render nothing,
 * which is the intended behavior.
 *
 * @see mt#1313 — Transcript search: harness-agnostic ingestion (§Subagent dedup)
 * @see mt#1324 — Foundation schema migration
 * @see mt#3692 — parent_tool_use_id identity + per-tool-call rows
 */
export const agentSpawnsTable = pgTable(
  "agent_spawns",
  {
    parentAgentSessionId: text("parent_agent_session_id")
      .notNull()
      .references(() => agentTranscriptsTable.agentSessionId),

    parentTurnIndex: integer("parent_turn_index").notNull(),

    /**
     * Harness-assigned `tool_use` id of the Agent call this row represents —
     * the table's natural key. Nullable only for pre-mt#3692 rows that could
     * not be backfilled; every row this pipeline writes sets it.
     */
    parentToolUseId: text("parent_tool_use_id"),

    // Nullable until the child transcript is ingested and linked back
    childAgentSessionId: text("child_agent_session_id"),

    // Spawn characteristics
    spawnType: text("spawn_type"), // 'foreground' | 'background'
    agentKind: text("agent_kind"), // 'general-purpose' | 'Explore' | 'refactorer' | ...

    // When the spawn was initiated (from parent JSONL timestamp)
    spawnedAt: timestamp("spawned_at", { withTimezone: true }),
  },
  (table) => [
    // The natural key, and the upsert conflict target for the extraction sweep.
    // Scoped by session: the tool_use id is unique per conversation, not corpus-wide.
    uniqueIndex("idx_agent_spawns_parent_tool_use_id").on(
      table.parentAgentSessionId,
      table.parentToolUseId
    ),
    // Replaces the lookup the former composite primary key provided. Plain, not
    // unique: a turn may carry several Agent calls (see the identity note above).
    index("idx_agent_spawns_parent_turn").on(table.parentAgentSessionId, table.parentTurnIndex),
    // mt#2767 (latency follow-up) — the former composite PK only covered
    // lookups keyed by parentAgentSessionId; both the context-inspector
    // widget's tier-3 subagent-descriptor lookup AND the unified run-list
    // merge's subagent-classification query filter on
    // `child_agent_session_id IN (...)` alone, which that key could not serve —
    // a full-table scan on every poll. Contributed to context-inspector's
    // own live-measured 2.93s response (2026-07-14), well above the
    // pre-merge baseline's 0.33s warm.
    index("idx_agent_spawns_child_agent_session_id").on(table.childAgentSessionId),
  ]
);

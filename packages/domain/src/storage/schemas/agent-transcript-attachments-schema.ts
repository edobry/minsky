import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { agentTranscriptsTable } from "./agent-transcripts-schema";

/**
 * Agent transcript attachments table — per-line rows for non-turn JSONL entries
 * (Claude Code `attachment` and `system` line types) that the existing
 * `agent_transcripts.transcript` jsonb column intentionally excludes.
 *
 * The canonical `RETAINED_TYPES` filter in `claude-code-transcript-source.ts`
 * was originally scoped to `user`/`assistant` to keep `transcript` jsonb
 * focused on turn content. The context-inspector use case (mt#2021) needs the
 * harness-emitted side material — hook injections, MCP-server instructions,
 * skill listings, deferred-tools deltas, task reminders, stop-hook summaries,
 * turn-duration metadata — and the right shape for it is a sibling table, not
 * an expansion of the turn-jsonb shape (which would change semantics for all
 * existing consumers — see `## Backwards-compat reasoning` in mt#2022).
 *
 * `line_index` is a stable per-session counter assigned by the ingest pipeline
 * as it iterates the source's filtered stream. Since the JSONL is append-only,
 * the counter is stable across re-ingest, so PK collisions are the natural
 * idempotency mechanism (ON CONFLICT DO NOTHING).
 *
 * @see mt#2022 — substrate extension; this schema
 * @see mt#2033 — canonical ContextAnalysisResult shape that the snapshot
 *                assembly function produces on top of these rows
 * @see mt#2021 — cockpit context-inspector umbrella
 */
export const agentTranscriptAttachmentsTable = pgTable(
  "agent_transcript_attachments",
  {
    agentSessionId: text("agent_session_id")
      .notNull()
      .references(() => agentTranscriptsTable.agentSessionId),

    /**
     * Stable per-session counter assigned by the ingest pipeline as it iterates
     * the source's filtered stream (0-indexed). Append-only JSONL → stable across
     * re-ingest → PK collisions on re-run are the idempotency mechanism.
     */
    lineIndex: integer("line_index").notNull(),

    /**
     * Raw JSONL `type` field — discriminates handling at read time.
     * Currently one of: `"attachment"`, `"system"`.
     */
    rawJsonlType: text("raw_jsonl_type").notNull(),

    /**
     * For `attachment` rows: the `attachment.type` discriminator (e.g.,
     * `"hook_additional_context"`, `"skill_listing"`, `"deferred_tools_delta"`,
     * `"mcp_instructions_delta"`, `"task_reminder"`, `"auto_mode"`).
     * For `system` rows: the `subtype` (e.g., `"stop_hook_summary"`,
     * `"turn_duration"`).
     */
    attachmentType: text("attachment_type").notNull(),

    /**
     * For `hook_additional_context` attachments: the hook event name
     * (e.g., `"UserPromptSubmit"`). Null for other attachment/system kinds.
     */
    hookEvent: text("hook_event"),

    /**
     * For `hook_additional_context` attachments: the specific hook script
     * resolved by content-preamble pattern matching (e.g., `"memory-search.ts"`,
     * `"skill-staleness-detector.ts"`). Null when no preamble match was found
     * OR when the row is not a hook injection.
     */
    hookName: text("hook_name"),

    /**
     * `parentUuid` from the JSONL line, linking attachments to their preceding
     * turn or attachment. Null when the JSONL line did not carry one.
     */
    parentUuid: text("parent_uuid"),

    /**
     * Full line content as JSONB — preserves the harness's original shape
     * (including nested attachment objects) for queryability without re-parsing.
     */
    content: jsonb("content").notNull(),

    /**
     * Timestamp from the JSONL line. Required for chronological ordering when
     * assembling a `SessionContextSnapshot`.
     */
    timestamp: timestamp("timestamp", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.agentSessionId, table.lineIndex] }),
    index("idx_agent_transcript_attachments_session_type").on(
      table.agentSessionId,
      table.attachmentType
    ),
    index("idx_agent_transcript_attachments_hook_name").on(table.hookName),
  ]
);

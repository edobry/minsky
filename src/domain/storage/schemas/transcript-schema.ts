import { pgTable, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";

/**
 * Session transcripts table — stores filtered Claude Code session transcripts.
 *
 * Ingested from JSONL files produced by Claude Code. Only `user` and `assistant`
 * type messages are retained; all other types (attachment, system, file-history-snapshot,
 * queue-operation, permission-mode, last-prompt, pr-link) are filtered out.
 *
 * These stored transcripts feed Phase 4 AI-based authorship tier judging.
 *
 * Conventions followed:
 * - session_id TEXT PRIMARY KEY (natural key, matches Minsky session IDs)
 * - jsonb for the transcript message array
 * - withTimezone on all timestamps
 *
 * @see mt#968 — Phase 2: transcript ingestion pipeline
 */
export const sessionTranscriptsTable = pgTable("session_transcripts", {
  sessionId: text("session_id").primaryKey(),

  // Filtered message array — only user/assistant entries with essential fields preserved
  transcript: jsonb("transcript").notNull(),

  // Message statistics
  messageCount: integer("message_count"),
  humanMessageCount: integer("human_message_count"),
  assistantMessageCount: integer("assistant_message_count"),

  // Audit
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow(),
});

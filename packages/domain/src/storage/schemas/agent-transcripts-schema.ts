import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { vector } from "drizzle-orm/pg-core";

/**
 * Agent transcripts table — stores harness-agnostic agent session transcripts.
 *
 * Keyed on the harness-native agent session ID (e.g., Claude Code's UUID),
 * NOT on the Minsky session ID (which is a separate concept). The many-to-many
 * relationship to Minsky sessions lives in minsky_session_links.
 *
 * Replaces the legacy session_transcripts table (dropped in the same migration).
 *
 * @see mt#1313 — Transcript search: harness-agnostic ingestion
 * @see mt#1324 — Foundation schema migration
 */
export const agentTranscriptsTable = pgTable("agent_transcripts", {
  agentSessionId: text("agent_session_id").primaryKey(),

  // Source harness — discriminator for adapter routing
  harness: text("harness").notNull(), // 'claude_code' | 'cursor' | 'minsky_native'

  // Session timing
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),

  // Session context
  model: text("model"),
  cwd: text("cwd"),
  projectDir: text("project_dir"),

  // Content — normalized turn array
  transcript: jsonb("transcript"),

  // Session-level summary and embedding
  summary: text("summary"),
  summaryEmbedding: vector("summary_embedding", { dimensions: 1536 }),

  // Regex-extracted references from transcript content
  relatedTaskIds: text("related_task_ids")
    .array()
    .default(sql`'{}'::text[]`),
  relatedPrNumbers: text("related_pr_numbers")
    .array()
    .default(sql`'{}'::text[]`),

  // Incremental ingest high-water-mark — tracks latest JSONL entry timestamp seen
  lastIngestedJsonlTimestamp: timestamp("last_ingested_jsonl_timestamp", { withTimezone: true }),

  // Audit
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).defaultNow(),
});

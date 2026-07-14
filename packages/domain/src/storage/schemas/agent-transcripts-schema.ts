import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { vector } from "drizzle-orm/pg-core";
import type { ConversationId } from "../../ids";

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
export const agentTranscriptsTable = pgTable(
  "agent_transcripts",
  {
    agentSessionId: text("agent_session_id").primaryKey().$type<ConversationId>(),

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
  },
  (table) => [
    // mt#2767 — the context-inspector widget (and the unified agents-widget
    // run-list merge) both run `ORDER BY started_at DESC LIMIT <=50` against
    // this table on every poll. This table has no index besides the primary
    // key (agent_session_id), so that query was a full-table sort — the
    // leading suspect for the ~30s first-paint latency observed on the
    // pre-unification /conversations page (2026-07-13 walkthrough) as the
    // table has grown past hundreds of ingested transcripts. NULLS LAST
    // matches the `${desc(...)} NULLS LAST` ordering already used by the
    // reverse-join query in routes/agents.ts.
    index("idx_agent_transcripts_started_at").on(table.startedAt.desc().nullsLast()),
  ]
);

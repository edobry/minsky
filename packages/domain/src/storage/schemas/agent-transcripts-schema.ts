import { pgTable, text, timestamp, jsonb, index, integer, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { vector } from "drizzle-orm/pg-core";
import type { ConversationId } from "../../ids";
import { projectsTable } from "./projects-schema";

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

    /**
     * Short generated conversation title (mt#3321) — a display LABEL, distinct
     * from `summary` above.
     *
     * Kept as its own column rather than reusing `summary`: `summary` is a 3-6
     * sentence paragraph whose whole purpose is to feed `summary_embedding`
     * for semantic search (`transcript-similarity-service.ts`), so overloading
     * it with a ~60-char title would break that consumer. Nullable — a
     * conversation with no title yet falls through to the older label tiers in
     * `conversation-label.ts`.
     */
    title: text("title"),

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

    // Project scoping (mt#2417, Phase 1.4). Unlike tasks_embeddings/memories_embeddings
    // (whose id column equals a scoped row's PK and is therefore covered transitively
    // via JOIN), a transcript's own id is the harness-native agent_session_id, which has
    // no required/enforced FK to any Minsky session (minsky_session_links is a soft,
    // best-effort many-to-many — many transcripts have zero linked session, e.g. ad-hoc
    // interactive conversations). project_id is therefore resolved directly at ingest
    // time from the transcript's own `cwd` (same resolver as the CLI/stdio MCP project
    // supplier, mt#2416/ADR-021) and stored here — nullable because resolution can fail
    // (unresolvable cwd, no matching project row) and ingestion must not block on it.
    projectId: uuid("project_id").references(() => projectsTable.id),

    // Ingest-failure tracking (mt#3278). Some ingest failures are permanent —
    // content Postgres cannot represent fails identically on every retry — so
    // without a record of past failures the sweep re-attempts a doomed
    // multi-megabyte upsert every 30 minutes forever. These columns make a
    // repeated failure visible and let the sweep skip a session that has
    // exhausted its attempts, instead of rediscovering the failure each pass.
    //
    // The counter is CONSECUTIVE: a successful ingest resets it to 0 and clears
    // the quarantine, so a transient DB blip never accumulates toward one.
    ingestFailureCount: integer("ingest_failure_count").notNull().default(0),
    ingestLastError: text("ingest_last_error"),
    ingestLastFailedAt: timestamp("ingest_last_failed_at", { withTimezone: true }),
    /** Set once the consecutive-failure threshold is crossed; NULL means not quarantined. */
    ingestQuarantinedAt: timestamp("ingest_quarantined_at", { withTimezone: true }),
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

-- Add agent_transcripts, agent_transcript_turns, agent_spawns, minsky_session_links tables.
-- Drop legacy session_transcripts table (keyed on Minsky session ID, superseded by agent-session-keyed schema).
-- Retarget provenance.transcript_id comment to agent_transcripts(agent_session_id).
--
-- mt#1324 — Foundation schema migration + TranscriptService rename
-- mt#1313 — Transcript search: harness-agnostic ingestion
--
-- Backout:
--   DROP TABLE IF EXISTS minsky_session_links;
--   DROP TABLE IF EXISTS agent_spawns;
--   DROP TABLE IF EXISTS agent_transcript_turns;
--   DROP TABLE IF EXISTS agent_transcripts;
--   CREATE TABLE session_transcripts (...); -- see 0023_session_transcripts.sql

-- Drop legacy session_transcripts table. The ~7 existing rows are keyed on Minsky
-- session IDs (no recoverable Claude Code session UUID) and will be re-ingested
-- via transcripts_ingest --all after mt#1325 ships.
DROP TABLE IF EXISTS "session_transcripts";
--> statement-breakpoint

-- Main transcripts table: harness-agnostic, keyed on the harness-native agent session ID.
CREATE TABLE IF NOT EXISTS "agent_transcripts" (
	"agent_session_id" text PRIMARY KEY NOT NULL,
	"harness" text NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"model" text,
	"cwd" text,
	"project_dir" text,
	"transcript" jsonb,
	"summary" text,
	"summary_embedding" vector(1536),
	"related_task_ids" text[] DEFAULT '{}'::text[],
	"related_pr_numbers" text[] DEFAULT '{}'::text[],
	"last_ingested_jsonl_timestamp" timestamp with time zone,
	"ingested_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint

-- Per-turn rows with vector embedding and full-text search.
CREATE TABLE IF NOT EXISTS "agent_transcript_turns" (
	"agent_session_id" text NOT NULL,
	"turn_index" integer NOT NULL,
	"user_text" text,
	"assistant_text" text,
	"tool_calls" jsonb,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"embedding" vector(1536),
	"fts_text" tsvector GENERATED ALWAYS AS (
		to_tsvector('english', coalesce(user_text, '') || ' ' || coalesce(assistant_text, ''))
	) STORED,
	"is_spawn_boundary" boolean DEFAULT false,
	PRIMARY KEY ("agent_session_id", "turn_index"),
	CONSTRAINT "agent_transcript_turns_agent_session_id_agent_transcripts_agent_session_id_fk"
		FOREIGN KEY ("agent_session_id") REFERENCES "agent_transcripts"("agent_session_id")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_agent_transcript_turns_fts"
	ON "agent_transcript_turns" USING gin ("fts_text");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_agent_transcript_turns_embedding"
	ON "agent_transcript_turns" USING hnsw ("embedding" vector_l2_ops);
--> statement-breakpoint

-- Spawn edges: parent turn → child agent session.
CREATE TABLE IF NOT EXISTS "agent_spawns" (
	"parent_agent_session_id" text NOT NULL,
	"parent_turn_index" integer NOT NULL,
	"child_agent_session_id" text,
	"spawn_type" text,
	"agent_kind" text,
	"spawned_at" timestamp with time zone,
	PRIMARY KEY ("parent_agent_session_id", "parent_turn_index"),
	CONSTRAINT "agent_spawns_parent_agent_session_id_agent_transcripts_agent_session_id_fk"
		FOREIGN KEY ("parent_agent_session_id") REFERENCES "agent_transcripts"("agent_session_id")
);
--> statement-breakpoint

-- Many-to-many: agent session ↔ Minsky session.
CREATE TABLE IF NOT EXISTS "minsky_session_links" (
	"agent_session_id" text NOT NULL,
	"minsky_session_id" text NOT NULL,
	"link_type" text NOT NULL,
	"confidence" real,
	"detected_at" timestamp with time zone DEFAULT now(),
	PRIMARY KEY ("agent_session_id", "minsky_session_id"),
	CONSTRAINT "minsky_session_links_agent_session_id_agent_transcripts_agent_session_id_fk"
		FOREIGN KEY ("agent_session_id") REFERENCES "agent_transcripts"("agent_session_id")
);

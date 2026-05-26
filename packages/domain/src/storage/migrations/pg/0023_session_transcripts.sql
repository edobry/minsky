-- Create session_transcripts table for storing Claude Code session transcripts.
-- Ingested from JSONL files; only user/assistant messages retained.
-- Feeds AI-based authorship tier judging (Phase 4).
CREATE TABLE IF NOT EXISTS "session_transcripts" (
	"session_id" text PRIMARY KEY NOT NULL,
	"transcript" jsonb NOT NULL,
	"message_count" integer,
	"human_message_count" integer,
	"assistant_message_count" integer,
	"ingested_at" timestamp with time zone DEFAULT now()
);

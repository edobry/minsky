-- mt#2022: extend transcripts substrate to retain JSONL attachment/system line
-- types alongside the existing user/assistant turns. New sibling table is
-- write-only via the ingest pipeline; PK collisions provide idempotency for
-- backfill re-runs (lineIndex is stable on an append-only JSONL).

CREATE TABLE IF NOT EXISTS "agent_transcript_attachments" (
  "agent_session_id" text NOT NULL,
  "line_index" integer NOT NULL,
  "raw_jsonl_type" text NOT NULL,
  "attachment_type" text NOT NULL,
  "hook_event" text,
  "hook_name" text,
  "parent_uuid" text,
  "content" jsonb NOT NULL,
  "timestamp" timestamp with time zone,
  CONSTRAINT "agent_transcript_attachments_agent_session_id_line_index_pk"
    PRIMARY KEY ("agent_session_id", "line_index"),
  CONSTRAINT "agent_transcript_attachments_agent_session_id_fk"
    FOREIGN KEY ("agent_session_id") REFERENCES "agent_transcripts"("agent_session_id")
);

CREATE INDEX IF NOT EXISTS "idx_agent_transcript_attachments_session_type"
  ON "agent_transcript_attachments" ("agent_session_id", "attachment_type");

CREATE INDEX IF NOT EXISTS "idx_agent_transcript_attachments_hook_name"
  ON "agent_transcript_attachments" ("hook_name");

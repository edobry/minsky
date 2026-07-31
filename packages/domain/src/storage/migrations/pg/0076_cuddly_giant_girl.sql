ALTER TABLE "agent_transcripts" ADD COLUMN "ingest_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_transcripts" ADD COLUMN "ingest_last_error" text;--> statement-breakpoint
ALTER TABLE "agent_transcripts" ADD COLUMN "ingest_last_failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_transcripts" ADD COLUMN "ingest_quarantined_at" timestamp with time zone;
ALTER TABLE "agent_transcripts" ADD COLUMN "title_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_transcripts" ADD COLUMN "title_skip_reason" text;
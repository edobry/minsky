ALTER TABLE "agent_transcripts" ADD COLUMN "divergent_tip_leaves" text[];--> statement-breakpoint
ALTER TABLE "agent_transcripts" ADD COLUMN "divergence_checked_at" timestamp with time zone;
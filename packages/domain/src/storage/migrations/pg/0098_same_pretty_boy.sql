ALTER TABLE "entity_thread_turns" ADD COLUMN "recovered_from_conversation_id" text;--> statement-breakpoint
ALTER TABLE "entity_thread_turns" ADD COLUMN "originally_sent_at" timestamp with time zone;
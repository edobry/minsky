ALTER TABLE "wake_pending" ALTER COLUMN "parent_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wake_pending" ADD COLUMN "agent_id" text;--> statement-breakpoint
CREATE INDEX "wake_pending_undelivered_by_agent" ON "wake_pending" USING btree ("agent_id") WHERE "wake_pending"."drained_at" IS NULL;
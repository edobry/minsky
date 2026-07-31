ALTER TABLE "subagent_invocations" ADD COLUMN "resumed_from_invocation_id" uuid;--> statement-breakpoint
ALTER TABLE "subagent_invocations" ADD COLUMN "attempt_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_subagent_invocations_resumed_from" ON "subagent_invocations" USING btree ("resumed_from_invocation_id");
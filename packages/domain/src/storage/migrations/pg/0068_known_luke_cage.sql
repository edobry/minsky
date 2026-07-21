DROP INDEX "idx_sessions_short_id_unique";--> statement-breakpoint
DROP INDEX "idx_memories_short_id_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sessions_short_id_unique" ON "sessions" USING btree ("short_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_memories_short_id_unique" ON "memories" USING btree ("short_id");
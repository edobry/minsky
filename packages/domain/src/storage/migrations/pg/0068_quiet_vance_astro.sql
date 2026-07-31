-- mt#2999: rebuild the memories/sessions short-id unique indexes as PLAIN
-- (non-partial), restoring the ADR-029 design. The partial variants shipped by
-- 0066/0067 (WHERE short_id IS NOT NULL) can never be inferred as the arbiter
-- for the create paths' bare ON CONFLICT ("short_id"), which broke every
-- memory_create and session_start in prod on 2026-07-21.
--
-- IF EXISTS (PR #2142 R1): prod was hotfixed out-of-band the same day (the
-- partial indexes were already dropped and recreated plain, same names), and a
-- drifted environment may lack the indexes entirely — the drop must not
-- hard-fail the migration chain in either case. Recreating an index that
-- already exists plain yields the identical end state.
--
-- Lock note (PR #2142 R1, non-blocking): plain CREATE UNIQUE INDEX (not
-- CONCURRENTLY) is deliberate — drizzle's migrate() runs each migration inside
-- a transaction, where CONCURRENTLY is not permitted, and both tables are tiny
-- at migration time (memories ~656 rows, sessions ~225 rows; short_id all-NULL
-- until backfill), so the ACCESS EXCLUSIVE window is milliseconds.
DROP INDEX IF EXISTS "idx_sessions_short_id_unique";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_memories_short_id_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sessions_short_id_unique" ON "sessions" USING btree ("short_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_memories_short_id_unique" ON "memories" USING btree ("short_id");

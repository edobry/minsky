-- PR #3503 R1 (mt#2911): re-pin the retired 'COMPLETED' enum orphan in the
-- schema-of-record. Every MIGRATED database already carries it (0037 added it,
-- 0055 collapsed rows to DONE, and Postgres cannot drop enum values), so this
-- is IF NOT EXISTS: a no-op on prod, and a parity fix for any fresh
-- bootstrap-path database created from a snapshot that dropped it.
ALTER TYPE "public"."task_status" ADD VALUE IF NOT EXISTS 'COMPLETED';--> statement-breakpoint
CREATE INDEX "work_package_members_member_task_id_idx" ON "work_package_members" USING btree ("member_task_id");

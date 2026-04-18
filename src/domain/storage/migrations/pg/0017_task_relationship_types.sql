-- Add type column to task_relationships for edge type discrimination
-- Values: 'depends' (existing behavior) | 'parent' (child→parent composition)
ALTER TABLE "task_relationships" ADD COLUMN "type" text NOT NULL DEFAULT 'depends';--> statement-breakpoint

-- Drop old 2-column unique constraint and replace with 3-column
DROP INDEX IF EXISTS "tr_unique_edge";--> statement-breakpoint
CREATE UNIQUE INDEX "tr_unique_edge" ON "task_relationships" USING btree ("from_task_id","to_task_id","type");--> statement-breakpoint

-- Enforce at most one parent per child task
CREATE UNIQUE INDEX "tr_one_parent" ON "task_relationships" USING btree ("from_task_id") WHERE type = 'parent';

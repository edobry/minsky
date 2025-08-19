DROP INDEX "idx_tasks_hnsw";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "dimension";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "embedding";
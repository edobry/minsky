CREATE TYPE "public"."task_status" AS ENUM('TODO', 'IN-PROGRESS', 'IN-REVIEW', 'DONE', 'BLOCKED', 'CLOSED');--> statement-breakpoint
ALTER TABLE "task_embeddings" RENAME TO "tasks";--> statement-breakpoint
DROP INDEX "idx_task_embeddings_ivf";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "status" "task_status";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "spec" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "last_indexed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_tasks_ivf" ON "tasks" USING ivfflat ("embedding" vector_l2_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tasks_task_id" ON "tasks" USING btree ("task_id");
ALTER TABLE "task_specs" DROP CONSTRAINT "task_specs_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks_embeddings" DROP CONSTRAINT "tasks_embeddings_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks_embeddings" ALTER COLUMN "indexed_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tasks_embeddings" ADD COLUMN "metadata" text;--> statement-breakpoint
ALTER TABLE "task_specs" DROP COLUMN "content_hash";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "content_hash";
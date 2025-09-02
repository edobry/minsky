ALTER TABLE "tasks_embeddings" ALTER COLUMN "backend" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "backend" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."task_backend";--> statement-breakpoint
CREATE TYPE "public"."task_backend" AS ENUM('markdown', 'json-file', 'github-issues', 'github', 'minsky', 'db');--> statement-breakpoint
ALTER TABLE "tasks_embeddings" ALTER COLUMN "backend" SET DATA TYPE "public"."task_backend" USING "backend"::"public"."task_backend";--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "backend" SET DATA TYPE "public"."task_backend" USING "backend"::"public"."task_backend";--> statement-breakpoint
ALTER TABLE "task_relationships" ADD CONSTRAINT "task_relationships_from_task_id_tasks_id_fk" FOREIGN KEY ("from_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_relationships" ADD CONSTRAINT "task_relationships_to_task_id_tasks_id_fk" FOREIGN KEY ("to_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
CREATE TYPE "public"."task_backend" AS ENUM('markdown', 'json-file', 'github-issues');--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "source_task_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "backend" "task_backend";
CREATE TYPE "public"."task_origin" AS ENUM('human', 'agent', 'automated');--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "origin" "task_origin";
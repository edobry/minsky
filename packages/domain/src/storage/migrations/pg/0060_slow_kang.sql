CREATE TYPE "public"."follow_up_status" AS ENUM('pending', 'fired', 'cancelled', 'failed');--> statement-breakpoint
CREATE TABLE "scheduled_follow_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" "follow_up_status" DEFAULT 'pending' NOT NULL,
	"related_task_id" text,
	"related_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fired_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE INDEX "idx_scheduled_follow_ups_status_due_at" ON "scheduled_follow_ups" USING btree ("status","due_at");
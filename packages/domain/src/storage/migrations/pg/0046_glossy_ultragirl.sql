CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"repo_url" text,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "asks" ADD COLUMN "project_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_projects_slug" ON "projects" USING btree ("slug");
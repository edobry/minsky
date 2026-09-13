CREATE TABLE "pointings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"query" jsonb NOT NULL,
	"autonomy_class" text DEFAULT 'pull-only' NOT NULL,
	"wip_limit" integer DEFAULT 1 NOT NULL,
	"project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "pointings" ADD CONSTRAINT "pointings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pointings_project_id_idx" ON "pointings" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pointings_project_name_live_idx" ON "pointings" USING btree ("project_id","name") WHERE archived_at IS NULL;
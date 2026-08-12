CREATE TABLE "guard_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stream" text NOT NULL,
	"family" text NOT NULL,
	"guard_name" text,
	"session_id" text,
	"project_id" uuid,
	"occurred_at" timestamp with time zone,
	"decision" text,
	"event" text,
	"duration_ms" integer,
	"payload" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"source_path" text,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guard_events" ADD CONSTRAINT "guard_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_guard_events_dedupe_key" ON "guard_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_guard_events_guard_name_occurred_at" ON "guard_events" USING btree ("guard_name","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_guard_events_stream_occurred_at" ON "guard_events" USING btree ("stream","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_guard_events_project_id_occurred_at" ON "guard_events" USING btree ("project_id","occurred_at");
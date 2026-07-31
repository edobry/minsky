CREATE TABLE "driven_session_cost" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"local_id" text NOT NULL,
	"harness_session_id" text,
	"task_id" text,
	"minsky_session_id" text,
	"turn_index" integer DEFAULT 0 NOT NULL,
	"subtype" text,
	"is_error" boolean DEFAULT false NOT NULL,
	"total_cost_usd" numeric(12, 6),
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_creation_input_tokens" integer,
	"cache_read_input_tokens" integer,
	"duration_ms" integer,
	"duration_api_ms" integer,
	"num_turns" integer,
	"model_usage" jsonb,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_dsc_local_id" ON "driven_session_cost" USING btree ("local_id");--> statement-breakpoint
CREATE INDEX "idx_dsc_harness_session_id" ON "driven_session_cost" USING btree ("harness_session_id");--> statement-breakpoint
CREATE INDEX "idx_dsc_task_id" ON "driven_session_cost" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_dsc_recorded_at" ON "driven_session_cost" USING btree ("recorded_at");
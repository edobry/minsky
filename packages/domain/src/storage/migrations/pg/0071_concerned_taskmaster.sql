CREATE TABLE "conversation_run_state" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"last_event_name" text NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL,
	"activity" text,
	"tool_name" text,
	"tool_started_at" timestamp with time zone,
	"prompt_id" text,
	"needs_input_reason" text,
	"needs_input_tool" text,
	"needs_input_at" timestamp with time zone,
	"last_error_type" text,
	"last_error_message" text,
	"last_error_at" timestamp with time zone,
	"last_compaction_trigger" text,
	"last_compaction_at" timestamp with time zone,
	"last_compaction_ended_at" timestamp with time zone,
	"ended_hint_at" timestamp with time zone,
	"ended_hint_reason" text,
	"cwd" text,
	"project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_run_state" ADD CONSTRAINT "conversation_run_state_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_conversation_run_state_last_event_at" ON "conversation_run_state" USING btree ("last_event_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_conversation_run_state_project_id" ON "conversation_run_state" USING btree ("project_id");
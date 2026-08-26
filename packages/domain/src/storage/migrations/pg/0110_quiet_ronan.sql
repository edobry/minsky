CREATE TABLE "task_supervision_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supervision_id" uuid NOT NULL,
	"task_id" text NOT NULL,
	"status" text DEFAULT 'dispatched' NOT NULL,
	"driven_session_local_id" text,
	"minsky_session_id" text,
	"settled_by" text,
	"last_error" text,
	"dispatched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_supervisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"umbrella_task_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_filter" text NOT NULL,
	"wip_limit" integer DEFAULT 4 NOT NULL,
	"model" text,
	"events_watermark" timestamp with time zone,
	"last_tick_at" timestamp with time zone,
	"last_advance_at" timestamp with time zone,
	"last_hold_reason" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "task_supervision_dispatches" ADD CONSTRAINT "task_supervision_dispatches_supervision_id_task_supervisions_id_fk" FOREIGN KEY ("supervision_id") REFERENCES "public"."task_supervisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_task_supervision_dispatches_supervision_status" ON "task_supervision_dispatches" USING btree ("supervision_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_task_supervision_dispatches_supervision_task" ON "task_supervision_dispatches" USING btree ("supervision_id","task_id");--> statement-breakpoint
CREATE INDEX "idx_task_supervisions_status" ON "task_supervisions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_task_supervisions_active_umbrella" ON "task_supervisions" USING btree ("umbrella_task_id") WHERE status = 'active';
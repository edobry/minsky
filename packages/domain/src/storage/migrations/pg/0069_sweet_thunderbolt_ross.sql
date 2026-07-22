CREATE TABLE "driven_sessions" (
	"local_id" text PRIMARY KEY NOT NULL,
	"harness_session_id" text,
	"cwd" text NOT NULL,
	"permission_mode" text NOT NULL,
	"task_id" text,
	"minsky_session_id" text,
	"status" text NOT NULL,
	"unrecoverable_reason" text,
	"pid" integer,
	"pid_cmdline" text,
	"actuator_generation" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_ds_harness_session_id" ON "driven_sessions" USING btree ("harness_session_id");--> statement-breakpoint
CREATE INDEX "idx_ds_task_id" ON "driven_sessions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_ds_status" ON "driven_sessions" USING btree ("status");
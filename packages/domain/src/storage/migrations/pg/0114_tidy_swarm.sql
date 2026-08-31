CREATE TABLE "work_package_members" (
	"package_task_id" text NOT NULL,
	"member_task_id" text NOT NULL,
	"rank" integer NOT NULL,
	"status_at_write" text,
	"rationale" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "work_package_members_package_task_id_member_task_id_pk" PRIMARY KEY("package_task_id","member_task_id")
);
--> statement-breakpoint
CREATE TABLE "work_package_transfers" (
	"package_task_id" text NOT NULL,
	"seq" integer NOT NULL,
	"origin" text NOT NULL,
	"by_conversation" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "work_package_transfers_package_task_id_seq_pk" PRIMARY KEY("package_task_id","seq")
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_package_members" ADD CONSTRAINT "work_package_members_package_task_id_tasks_id_fk" FOREIGN KEY ("package_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_package_transfers" ADD CONSTRAINT "work_package_transfers_package_task_id_tasks_id_fk" FOREIGN KEY ("package_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
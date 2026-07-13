CREATE TABLE "reviewer_submission_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"error_class" text NOT NULL,
	"last_status" integer,
	"last_message" text,
	"consecutive_count" integer DEFAULT 1 NOT NULL,
	"circuit_open" boolean DEFAULT false NOT NULL,
	"alerted" boolean DEFAULT false NOT NULL,
	"first_failure_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_failure_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_submission_failure_pr_head" ON "reviewer_submission_failures" USING btree ("owner","repo","pr_number","head_sha");--> statement-breakpoint
CREATE INDEX "idx_rsf_circuit_open" ON "reviewer_submission_failures" USING btree ("circuit_open");
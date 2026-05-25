CREATE TABLE "review_timing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pr_owner" text NOT NULL,
	"pr_repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"iteration_index" integer NOT NULL,
	"total_wall_clock_ms" integer NOT NULL,
	"per_round_latencies_ms" integer[] DEFAULT '{}'::int[] NOT NULL,
	"timeout_count" integer DEFAULT 0 NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"retry_outcomes" text[] DEFAULT '{}'::text[] NOT NULL,
	"scope_classification" text,
	"tool_use_active" boolean,
	"provider" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_rt_pr_iteration" ON "review_timing" USING btree ("pr_owner","pr_repo","pr_number","iteration_index");--> statement-breakpoint
CREATE INDEX "idx_rt_created_at" ON "review_timing" USING btree ("created_at");

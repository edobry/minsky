-- Hand-augmented: gen_random_uuid() requires pgcrypto. drizzle-kit doesn't auto-emit CREATE EXTENSION;
-- adding it here ensures the migration succeeds on fresh databases. See PR #849 review (mt#1306).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE TABLE "reviewer_convergence_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pr_owner" text NOT NULL,
	"pr_repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"iteration_index" integer NOT NULL,
	"prior_blocker_count" integer NOT NULL,
	"new_blocker_count" integer NOT NULL,
	"acknowledged_addressed_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_rcm_pr_iteration" ON "reviewer_convergence_metrics" USING btree ("pr_owner","pr_repo","pr_number","iteration_index");--> statement-breakpoint
CREATE INDEX "idx_rcm_created_at" ON "reviewer_convergence_metrics" USING btree ("created_at");
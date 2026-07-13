-- Migration: add reviewer_inflight_reviews table (mt#1907)
-- In-flight marker to eliminate the sweeper-vs-webhook double-trigger race.
-- The marker is acquired at runReview entry, released at runReview exit,
-- and expires after REVIEWER_INFLIGHT_MARKER_TTL_MS (default 5 min).
-- A sweeper-vs-webhook concurrent acquisition attempt uses
-- INSERT ... ON CONFLICT DO NOTHING RETURNING id to determine who owns
-- the review slot for a given (owner, repo, pr_number, head_sha) tuple.
--> statement-breakpoint
CREATE TABLE "reviewer_inflight_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"acquired_by" text NOT NULL,
	"delivery_id" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uniq_pr_head" UNIQUE("owner", "repo", "pr_number", "head_sha")
);
--> statement-breakpoint
CREATE INDEX "idx_rir_expires_at" ON "reviewer_inflight_reviews" USING btree ("expires_at");

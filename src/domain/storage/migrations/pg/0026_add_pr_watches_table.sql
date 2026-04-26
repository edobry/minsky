-- Add pr_watches table — subscription records for the operator PR-state watcher.
-- mt#1294 (parent mt#1234).
--
-- Backout: DROP TABLE IF EXISTS pr_watches;

CREATE TABLE IF NOT EXISTS "pr_watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pr_owner" text NOT NULL,
	"pr_repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"event" text NOT NULL,
	"keep" boolean NOT NULL,
	"watcher_id" text NOT NULL,
	"last_seen" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"triggered_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "chk_pr_watches_event" CHECK (event IN ('merged', 'review-posted', 'check-status-changed'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_pr_watches_pr" ON "pr_watches" ("pr_owner", "pr_repo", "pr_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pr_watches_triggered_at" ON "pr_watches" ("triggered_at");

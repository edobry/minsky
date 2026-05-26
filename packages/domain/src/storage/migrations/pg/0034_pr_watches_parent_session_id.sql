-- Add parent_session_id column to pr_watches — mt#1725 WakeSignalSink integration.
--
-- Captures the Minsky session UUID of the agent that registered the watch at
-- pr_watch_create time. When the watcher fires, the reviewer-service scheduler
-- emits a PersistentWakeSignalSink row keyed on this session ID so the registering
-- agent receives the wake signal via enrichWakeResponse on its next allowlisted
-- MCP tool call.
--
-- Nullable: legacy rows (registered before this migration) have null and are
-- skipped at delivery time (no session to route to; telemetered as
-- wake.enrichment.no_session_id).
--
-- Backout:
--   ALTER TABLE pr_watches DROP COLUMN IF EXISTS parent_session_id;
--   DROP INDEX IF EXISTS idx_pr_watches_parent_session;

ALTER TABLE "pr_watches"
  ADD COLUMN IF NOT EXISTS "parent_session_id" text;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_pr_watches_parent_session"
  ON "pr_watches" ("parent_session_id")
  WHERE "parent_session_id" IS NOT NULL;

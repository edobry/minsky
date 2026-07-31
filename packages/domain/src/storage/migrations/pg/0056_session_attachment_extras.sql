-- mt#2284: session-grain runtime-attachment extras on presence_claims.
-- Adds the nullable columns the session grain (subject_kind = 'session') needs
-- beyond mt#2562's canonical task-grain shape: pid (OS-level attachment identity,
-- used by the session-attachment stale reaper), entrypoint (CLAUDE_CODE_ENTRYPOINT),
-- and terminal_context (env bag: TERM_PROGRAM/TERM_SESSION_ID/TERM/TMUX/TMUX_PANE/
-- WEZTERM_PANE/KITTY_WINDOW_ID — only the keys present).
--
-- NOTE: this migration intentionally excludes an unrelated, pre-existing drizzle-kit
-- diff on `tasks.status` / the `task_status` enum (dropping the orphaned COMPLETED
-- value left by mt#2311/migration 0055's data-only collapse). That drift predates
-- this task and is out of scope here; it remains detectable by a future
-- `bun run db:generate:pg` run against a task that owns the enum cleanup.
--
-- Backout: ALTER TABLE presence_claims DROP COLUMN IF EXISTS "pid", DROP COLUMN IF EXISTS
-- "entrypoint", DROP COLUMN IF EXISTS "terminal_context";

ALTER TABLE "presence_claims" ADD COLUMN "pid" integer;--> statement-breakpoint
ALTER TABLE "presence_claims" ADD COLUMN "entrypoint" text;--> statement-breakpoint
ALTER TABLE "presence_claims" ADD COLUMN "terminal_context" jsonb;

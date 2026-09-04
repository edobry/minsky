-- mt#4935: make the drive record harness-agnostic (ADR-047 §Consequences).
--
-- Three of the four new `driven_sessions` columns get a constant DB-level
-- default matching today's only harness/transport/auth-mode value, so the
-- ADD COLUMN itself backfills every existing row (Postgres applies a
-- constant DEFAULT to existing rows at ADD COLUMN time — no separate UPDATE
-- needed, no full-table rewrite for a non-volatile default). The fourth,
-- harness_conversation_id, is row-dependent (mirrors that row's own
-- harness_session_id, not a constant), so it is backfilled explicitly below.
ALTER TABLE "driven_sessions" ADD COLUMN "harness_kind" text DEFAULT 'claude-code' NOT NULL;--> statement-breakpoint
ALTER TABLE "driven_sessions" ADD COLUMN "transport_id" text DEFAULT 'claude-stream-json' NOT NULL;--> statement-breakpoint
ALTER TABLE "driven_sessions" ADD COLUMN "harness_conversation_id" text;--> statement-breakpoint
ALTER TABLE "driven_sessions" ADD COLUMN "auth_mode" text DEFAULT 'subscription' NOT NULL;--> statement-breakpoint
-- Backfill: for every existing row, the harness's own conversation id is
-- exactly what harness_session_id already recorded (the only harness this
-- table has ever tracked is Claude Code, so this is trivially correct — not
-- an inference). Rows with a NULL harness_session_id (never linked) stay
-- NULL, matching harness_session_id's own nullability.
UPDATE "driven_sessions" SET "harness_conversation_id" = "harness_session_id";

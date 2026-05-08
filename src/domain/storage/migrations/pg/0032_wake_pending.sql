-- Add wake_pending table — mt#1661 v0 short-term bridge for in-conversation
-- wake-signal delivery (mt#1519 §5).
--
-- Producer side: PersistentWakeSignalSink writes one row per quality.review Ask
-- responded transition. Consumer side: enrichWakeResponse MCP middleware drains
-- undelivered rows for the calling session at every allowlisted tool call.
--
-- v0 scope deliberately keys on parent_session_id only — no agent_id column.
-- Cross-session / agent-handoff delivery requires the InterfaceBinding model
-- designed in mt#1506.
--
-- Backout:
--   DROP INDEX IF EXISTS wake_pending_undelivered;
--   DROP TABLE IF EXISTS wake_pending;

CREATE TABLE IF NOT EXISTS "wake_pending" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "parent_session_id"  text NOT NULL,
  "ask_id"             text NOT NULL,
  "payload_json"       jsonb NOT NULL,
  "emitted_at"         timestamp with time zone NOT NULL DEFAULT now(),
  "drained_at"         timestamp with time zone,
  "drained_for_tool"   text
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "wake_pending_undelivered"
  ON "wake_pending" ("parent_session_id")
  WHERE "drained_at" IS NULL;

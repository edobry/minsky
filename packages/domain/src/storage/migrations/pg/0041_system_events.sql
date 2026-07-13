-- Add system_events table — mt#2092 (Event log Phase 1a).
--
-- Persists actionable events emitted by the Minsky system and remote producers
-- (adoption sweeper via events.emit MCP tool). The table is append-only.
--
-- v1 event types: ask.created, task.auto_created, pr.review_posted, subagent.failed
--
-- Backout:
--   DROP INDEX IF EXISTS idx_system_events_related_task_id;
--   DROP INDEX IF EXISTS idx_system_events_created_at;
--   DROP INDEX IF EXISTS idx_system_events_event_type;
--   DROP TABLE IF EXISTS system_events;
--   DROP TYPE IF EXISTS system_event_type;

-- Guarded enum creation: PG's CREATE TYPE does not support IF NOT EXISTS,
-- so wrap in a DO block that swallows duplicate_object errors. Lets the
-- migration be re-applied safely after a partial failure without manual
-- intervention.
DO $$
BEGIN
  CREATE TYPE "system_event_type" AS ENUM (
    'ask.created',
    'task.auto_created',
    'pr.review_posted',
    'subagent.failed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "system_events" (
  -- Identity
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_type"          "system_event_type" NOT NULL,

  -- Payload
  "payload"             jsonb NOT NULL,

  -- Context
  "actor"               text,
  "related_task_id"     text,
  "related_session_id"  text,

  -- Timestamp
  "created_at"          timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Event type filtering (cockpit activity feed type filter)
CREATE INDEX IF NOT EXISTS "idx_system_events_event_type"
  ON "system_events" ("event_type");
--> statement-breakpoint

-- Chronological queries — DESC for most-recent-first reads
CREATE INDEX IF NOT EXISTS "idx_system_events_created_at"
  ON "system_events" ("created_at");
--> statement-breakpoint

-- Related task lookup
CREATE INDEX IF NOT EXISTS "idx_system_events_related_task_id"
  ON "system_events" ("related_task_id");

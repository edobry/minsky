-- Add subagent_invocations table — mt#1735 (foundation subtask for mt#1005).
--
-- Persists execution history for subagent dispatches. Each row records one
-- subagent invocation: dispatch params, timing, outcome (6-class enum), metrics,
-- and workspace state.
--
-- The agent_session_id column joins to agent_transcripts.agent_session_id
-- (mt#1313) and agent_spawns.agent_session_id (mt#1324).
--
-- Backout:
--   DROP INDEX IF EXISTS idx_subagent_invocations_outcome;
--   DROP INDEX IF EXISTS idx_subagent_invocations_started_at;
--   DROP INDEX IF EXISTS idx_subagent_invocations_agent_session_id;
--   DROP INDEX IF EXISTS idx_subagent_invocations_task_id;
--   DROP TABLE IF EXISTS subagent_invocations;
--   DROP TYPE IF EXISTS subagent_invocation_outcome;

CREATE TYPE "subagent_invocation_outcome" AS ENUM (
  'completed-with-pr',
  'committed-no-pr',
  'partial-committed-handoff-written',
  'partial-uncommitted-no-handoff',
  'crashed-no-output',
  'rate-limited'
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "subagent_invocations" (
  -- Identity
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id"              text NOT NULL,
  "session_id"           text,
  "agent_session_id"     text,
  "parent_session_id"    text,
  "parent_task_id"       text,
  "subagent_session_id"  text,

  -- Dispatch params
  "agent_type"           text NOT NULL,
  "suggested_model"      text,
  "actual_model"         text,

  -- Timing
  "started_at"           timestamp with time zone NOT NULL,
  "ended_at"             timestamp with time zone,
  "duration_ms"          integer,

  -- Metrics
  "tool_use_count"       integer,
  "total_tokens"         integer,

  -- Outcome
  "outcome"              "subagent_invocation_outcome" NOT NULL,
  "error_summary"        text,
  "summary"              text,

  -- Workspace state
  "pr_url"               text,
  "last_commit_hash"     text,
  "handoff_written"      boolean
);
--> statement-breakpoint

-- Primary lookup: all invocations for a given task
CREATE INDEX IF NOT EXISTS "idx_subagent_invocations_task_id"
  ON "subagent_invocations" ("task_id");
--> statement-breakpoint

-- Join to agent_transcripts / agent_spawns
CREATE INDEX IF NOT EXISTS "idx_subagent_invocations_agent_session_id"
  ON "subagent_invocations" ("agent_session_id");
--> statement-breakpoint

-- Chronological queries and time-range scans
CREATE INDEX IF NOT EXISTS "idx_subagent_invocations_started_at"
  ON "subagent_invocations" ("started_at");
--> statement-breakpoint

-- Outcome-class aggregation and filtering
CREATE INDEX IF NOT EXISTS "idx_subagent_invocations_outcome"
  ON "subagent_invocations" ("outcome");

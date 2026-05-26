-- Add COMPLETED to the task_status enum — mt#1812 / PR #1131 R1 BLOCKING
--
-- The umbrella kind (introduced in mt#1812) uses COMPLETED as its success
-- terminal state, analogous to DONE for the implementation kind. The Drizzle
-- schema derives the Postgres enum from `Object.values(TaskStatus)` at code
-- gen time, so without this migration the existing `task_status` enum (which
-- predates COMPLETED) rejects any attempt to persist `status='COMPLETED'`.
--
-- Pattern matches earlier enum extensions (0018_add_planning_status.sql,
-- 0019_add_ready_status.sql).
--
-- Backout: there is no clean PG-native way to drop an enum value once added.
-- If COMPLETED needs to be retired, migrate to a text+check-constraint pattern
-- in a follow-up; that's out of scope here.

ALTER TYPE "public"."task_status" ADD VALUE IF NOT EXISTS 'COMPLETED';

-- Add kind column to tasks table — mt#1812
--
-- Introduces the task `kind` field, which selects the per-kind workflow
-- definition (state machine, allowed transitions, terminal states).
--
-- v1 kinds: "implementation" (existing state machine), "umbrella" (new
-- simpler lifecycle for epic/metadata tasks that complete without a PR).
--
-- Default 'implementation' keeps all existing rows on the current state
-- machine — zero behavioral change without an explicit backfill.
--
-- Backout:
--   ALTER TABLE tasks DROP COLUMN IF EXISTS kind;

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'implementation';

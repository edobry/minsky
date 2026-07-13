-- Add deleted_task_ids tombstone table — mt#2205.
--
-- Records every task ID that has ever been deleted, so the minsky task
-- backend's ID allocator (generateTaskId) can compute its high-water mark
-- over live tasks UNION deleted-task tombstones. This makes task ID
-- allocation monotonic: a freed ID is NEVER re-handed-out, preserving the
-- invariant that a task ID is a stable permanent reference (cross-references
-- in other specs, memories, and PRs point to an ID expecting it to mean one
-- thing forever).
--
-- Companion fix: deleteTask now hard-purges the task's dependent rows
-- (task_specs, tasks_embeddings) which were orphaned after migration 0011
-- dropped their ON DELETE CASCADE foreign keys. The tombstone row is what
-- survives a delete to anchor the high-water mark.
--
-- Backout:
--   DROP TABLE IF EXISTS deleted_task_ids;
CREATE TABLE IF NOT EXISTS "deleted_task_ids" (
  "id"          text PRIMARY KEY,
  "deleted_at"  timestamp with time zone DEFAULT now() NOT NULL
);

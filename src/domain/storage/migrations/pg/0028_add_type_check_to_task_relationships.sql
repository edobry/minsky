-- Add CHECK constraint on task_relationships.type to enforce valid values.
-- Valid values: 'depends' | 'parent' (matching RELATIONSHIP_TYPE_VALUES in src/domain/storage/schemas/task-relationships.ts)
-- Does NOT alter or drop the column — only adds the constraint.
--
-- Pre-condition: all existing rows must satisfy the constraint.
-- The SELECT below will error if any row has an invalid type value,
-- preventing the migration from proceeding:
--   SELECT 1 FROM task_relationships WHERE type NOT IN ('depends', 'parent') LIMIT 1;
--
-- Backout: ALTER TABLE task_relationships DROP CONSTRAINT IF EXISTS chk_task_relationships_type;

ALTER TABLE "task_relationships"
  ADD CONSTRAINT "chk_task_relationships_type"
  CHECK (type IN ('depends', 'parent'));

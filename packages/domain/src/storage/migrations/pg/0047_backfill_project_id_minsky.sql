-- Custom data migration: create the Minsky project row and backfill project_id
-- on tasks, sessions, and asks (mt#2415, Phase 1.2 of mt#2391).
--
-- Idempotent: ON CONFLICT (slug) DO NOTHING ensures re-running is safe.
-- The UPDATEs only touch rows where project_id IS NULL, so re-running
-- after a partial run completes cleanly.
--
-- Interruption between migration 0046 (schema) and this file (data) leaves
-- the DB fully usable: the columns are nullable, no NOT NULL constraint exists.

-- 1. Insert the Minsky project row (idempotent).
INSERT INTO projects (slug, repo_url, display_name)
VALUES ('edobry/minsky', 'https://github.com/edobry/minsky.git', 'Minsky')
ON CONFLICT (slug) DO NOTHING;

-- 2. Backfill tasks.project_id for all existing rows.
UPDATE tasks
SET project_id = (SELECT id FROM projects WHERE slug = 'edobry/minsky')
WHERE project_id IS NULL;

-- 3. Backfill sessions.project_id for all existing rows.
UPDATE sessions
SET project_id = (SELECT id FROM projects WHERE slug = 'edobry/minsky')
WHERE project_id IS NULL;

-- 4. Backfill asks.project_id for all existing rows.
UPDATE asks
SET project_id = (SELECT id FROM projects WHERE slug = 'edobry/minsky')
WHERE project_id IS NULL;

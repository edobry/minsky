-- Custom data migration: backfill agent_transcripts.project_id for
-- pre-existing rows (mt#2417, Phase 1.4 of mt#2391).
--
-- Migration 0061 added the nullable project_id column; every row ingested
-- BEFORE that migration has project_id = NULL. Without this backfill, a
-- default-scoped read (resolveTranscriptProjectScope resolving to the
-- Minsky project) would silently exclude every pre-existing transcript --
-- the same "vanishes from default views" gap mt#2415's 0047 backfill closed
-- for tasks/sessions/asks. Follows the identical pattern: idempotent Minsky
-- project row insert (defensive -- 0047 already created it on any DB that
-- reaches this migration) + an UPDATE restricted to project_id IS NULL, so
-- re-running after a partial run, or running on a DB where some rows were
-- already resolved via the ingest-time resolver (mt#2417), is a no-op for
-- those rows.
--
-- Single-project instance today: at the time this migration runs, every
-- pre-existing transcript was ingested by (and therefore belongs to) this
-- Minsky instance -- there is no multi-project ambiguity to resolve here,
-- matching 0047's reasoning for tasks/sessions/asks.

-- 1. Insert the Minsky project row (idempotent; defensive -- 0047 already
--    created it on any DB old enough to have pre-0061 agent_transcripts rows).
INSERT INTO projects (slug, repo_url, display_name)
VALUES ('edobry/minsky', 'https://github.com/edobry/minsky.git', 'Minsky')
ON CONFLICT (slug) DO NOTHING;

-- 2. Backfill agent_transcripts.project_id for pre-existing NULL rows.
UPDATE agent_transcripts
SET project_id = (SELECT id FROM projects WHERE slug = 'edobry/minsky')
WHERE project_id IS NULL;
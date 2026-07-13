-- Drop vestigial tasks_embeddings.status / .backend columns — mt#2250 (revives mt#2223)
--
-- ADR-013 (mt#2220) moved task similarity search to read-time domain filtering:
-- the similarity service JOINs the live `tasks` table for each candidate's
-- status/backend rather than reading denormalized copies off tasks_embeddings.
-- That made the denormalized `status` and `backend` columns on tasks_embeddings
-- vestigial (and the source of the mt#2220 NULL-status bug). They were already
-- dropped out-of-band on production (see mt#1641 / mt#2229); this migration
-- records the drop in the journal so a fresh-from-journal database matches
-- production. `IF EXISTS` makes it a safe no-op where the columns are already gone.
--
-- The `task_status` / `task_backend` enum TYPES are intentionally NOT dropped —
-- the `tasks` table still uses them.
--
-- Backout:
--   ALTER TABLE "tasks_embeddings" ADD COLUMN IF NOT EXISTS "status" "task_status";
--   ALTER TABLE "tasks_embeddings" ADD COLUMN IF NOT EXISTS "backend" "task_backend";

ALTER TABLE "tasks_embeddings" DROP COLUMN IF EXISTS "status";--> statement-breakpoint
ALTER TABLE "tasks_embeddings" DROP COLUMN IF EXISTS "backend";

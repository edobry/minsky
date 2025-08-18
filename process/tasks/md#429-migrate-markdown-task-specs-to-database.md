# Migrate Markdown Task Specs to Database

## Status

IN-PROGRESS

## Context

Migrate markdown-based tasks to the database `tasks` table using the existing `minsky tasks migrate` command. This task extends the existing migration command to import markdown task metadata into the database by default (no separate importer flag). It does not introduce or switch to a new backend; it provides an importer only, keeping current behavior intact while enabling a migration path.

## Requirements

1. Schema readiness

   - Ensure `tasks` table exists with columns:
     - `id` (PK, qualified task ID like `md#123`)
     - `backend` (enum: markdown | json-file | github-issues)
     - `source_task_id` (local ID after `md#`, stored as string)
     - `status`, `title`, `spec` (markdown content)
     - `content_hash`, `last_indexed_at`, timestamps
   - Introduce separate `tasks_embeddings` table for vector data (split from `tasks`):
     - `task_id` (PK, references `tasks.id`)
     - `dimension` (INT NOT NULL)
     - `embedding` (vector)
     - `last_indexed_at` (TIMESTAMPTZ)
     - Index: HNSW on `embedding` using `vector_l2_ops` (avoid IVFFlat; HNSW only)
   - Remove `dimension`, `embedding`, `metadata` (and the HNSW index) from `tasks` in a follow-up migration within this task
   - No manual SQL; update Drizzle schema only, Drizzle Kit generates migrations

2. CLI import (extend existing)

   - `minsky tasks migrate` imports markdown → DB by default (no `--import-specs-to-db` flag)
   - Dry-run by default; `--execute` to apply changes
   - Options: `--limit N`, `--filter-status STATUS`, `--json`
   - Output: clear plan of inserts/updates/skips; JSON mode supported

3. ID handling

   - No legacy ID normalization (legacy formats are no longer accepted)
   - Derive and store `backend = 'markdown'` and `source_task_id = '123'` from qualified IDs
   - Deduplicate on `id` (idempotent reruns)

4. Data mapping

   - Source: central `process/tasks.md` + per-task spec files
   - Target fields (metadata): `id` (qualified), `backend`, `source_task_id`, `status`, `title`, `spec`, `content_hash`

5. Embeddings

   - `PostgresVectorStorage` must not write task metadata
   - Store embeddings exclusively in `tasks_embeddings`
   - Use existing `minsky tasks index-embeddings` to compute/store vectors; do not add a reindex flag to migrate

6. Safety & idempotency

   - No destructive operations by default
   - Re-runnable without duplication (UPSERT on `tasks.id` and `tasks_embeddings.task_id`)
   - Clear conflict handling/reporting

7. Documentation
   - Update docs to describe schema-first migrations and import workflow
   - Explain intermediate state (still using markdown backend; importer prepares data for later backend swap)

## Solution

### CLI

Extend existing `tasks migrate` (no importer flag):

Behavior:

- Scan markdown tasks and spec files
- Upsert normalized metadata into `tasks` (no legacy ID conversion; assume qualified IDs)
- Embeddings are not handled by migrate; use `minsky tasks index-embeddings` to populate `tasks_embeddings`

### Implementation Notes

- Use existing markdown parsing utilities to read tasks and specs
- Use the configuration-backed PG connection (sessiondb.postgres) for DB writes
- Use Drizzle for inserts/updates, with UPSERT on `tasks.id`
- Set `backend = 'markdown'` and derive `source_task_id` from `id`
- Refactor `PostgresVectorStorage` to use `tasks_embeddings` exclusively for vector data; it must not write task metadata
- Add HNSW index creation for `tasks_embeddings` and remove any legacy IVFFlat references
- Follow-up migration: drop `tasks.dimension`, `tasks.embedding`, `tasks.metadata`, and the `idx_tasks_hnsw` index on `tasks`
- Defer any backend switching; this task is import-only

## Considerations & Non-Goals

- Not introducing a `pg-tasks` backend in this task (tracked separately)
- No changes to user-facing task backend selection; markdown remains active
- No global test updates required in this task (will be done with backend introduction)
- Future GH Issues migration will build on having tasks in DB first

## Notes

- Follow persistence rules: schema-first, Drizzle Kit generated migrations, and `sessiondb migrate` for application (dry-run by default)

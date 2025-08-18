# Migrate Markdown Task Specs to Database

## Status

TODO

## Context

Migrate markdown-based tasks to the database `tasks` table with ID normalization via the existing `minsky tasks migrate` command. This task extends the existing migration command with an importer mode rather than adding a new command. It does not introduce or switch to a new backend; it provides an importer only, keeping current behavior intact while enabling a migration path.

## Requirements

1. Schema readiness

   - Ensure `tasks` table exists with columns:
     - `id` (PK, qualified task ID like `md#123`)
     - `backend` (enum: markdown | json-file | github-issues)
     - `source_task_id` (local ID after `md#`, stored as string)
     - `status`, `title`, `spec` (markdown content)
     - `dimension`, `embedding` (optional, only when reindex enabled)
     - `content_hash`, `last_indexed_at`, timestamps
   - No manual SQL; update Drizzle schema only, Drizzle Kit generates migrations

2. Importer CLI (extend existing)

   - Extend `minsky tasks migrate` with an importer mode for markdown → DB, instead of creating a new command
   - Proposed usage:
     - `minsky tasks migrate --import-specs-to-db [--execute] [--limit N] [--filter-status STATUS] [--reindex-embeddings] [--json]`
   - Dry-run by default; `--execute` to apply changes
   - Output: clear plan of inserts/updates/skips; JSON mode supported

3. ID normalization

   - Convert legacy numeric or `#123` IDs to qualified form (e.g., `123`/`#123` → `md#123`) for the `id` PK
   - Derive and store `backend = 'markdown'` and `source_task_id = '123'`
   - Deduplicate on `id` (idempotent reruns)

4. Data mapping

   - Source: central `process/tasks.md` + per-task spec files
   - Target fields: `id` (qualified), `backend`, `source_task_id`, `status`, `title`, `spec`
   - Compute and store `content_hash` for spec
   - Set `dimension`, `embedding`, and `last_indexed_at` only if `--reindex-embeddings` is provided

5. Safety & idempotency

   - No destructive operations by default
   - Re-runnable without duplication (UPSERT on `id`)
   - Clear conflict handling/reporting

6. Documentation
   - Update docs to describe schema-first migrations and import workflow
   - Explain intermediate state (still using markdown backend; importer prepares data for later backend swap)

## Solution

### CLI

Extend existing `tasks migrate`:

`minsky tasks migrate --import-specs-to-db [--execute] [--limit N] [--filter-status STATUS] [--json] [--reindex-embeddings]`

Behavior:

- Scan markdown tasks and spec files
- Normalize IDs and upsert into `tasks`
- On `--reindex-embeddings`, compute embeddings and write `embedding`, `dimension`, update `content_hash` and `last_indexed_at`

### Implementation Notes

- Use existing markdown parsing utilities to read tasks and specs
- Use the configuration-backed PG connection (sessiondb.postgres) for DB writes
- Use Drizzle for inserts/updates, with UPSERT on `id`
- Set `backend = 'markdown'` and derive `source_task_id` from `id`
- Defer any backend switching; this task is import-only

## Considerations & Non-Goals

- Not introducing a `pg-tasks` backend in this task (tracked separately)
- No changes to user-facing task backend selection; markdown remains active
- No global test updates required in this task (will be done with backend introduction)
- Future GH Issues migration will build on having tasks in DB first

## Notes

- Follow persistence rules: schema-first, Drizzle Kit generated migrations, and `sessiondb migrate` for application (dry-run by default)

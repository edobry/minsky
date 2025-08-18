# Migrate Markdown Task Specs to Database

## Status

TODO

## Context

Migrate markdown-based tasks to the database `tasks` table with ID normalization and a safe, dry-run-first CLI. This task does not introduce or switch to a new backend; it provides an importer only, keeping current behavior intact while enabling a migration path.

## Requirements

1. Schema readiness

   - Ensure `tasks` table exists with columns: `id` (PK), `task_id` (unique after backfill), `status`, `title`, `spec` (markdown), `content_hash`, `last_indexed_at`, timestamps
   - No manual SQL; update Drizzle schema only, Drizzle Kit generates migrations

2. Importer CLI

   - Command: `minsky tasks import-from-markdown` (name TBD)
   - Dry-run by default; `--execute` to apply changes
   - Options: `--limit`, `--filter-status`, `--reindex-embeddings` (optional)
   - Output: clear plan of inserts/updates/skips; JSON mode supported

3. ID normalization

   - Convert legacy numeric IDs to qualified form (e.g., `123` → `md#123`) when writing `task_id`
   - Preserve existing qualified IDs
   - Deduplicate on `task_id` (idempotent reruns)

4. Data mapping

   - Source: central `process/tasks.md` + per-task spec files
   - Target fields: `task_id`, `status`, `title`, `spec`
   - Compute and store `content_hash` for spec
   - Set `last_indexed_at` only if embeddings reindex opt-in

5. Safety & idempotency

   - No destructive operations by default
   - Re-runnable without duplication (UPSERT on `task_id`)
   - Clear conflict handling/reporting

6. Documentation
   - Update docs to describe schema-first migrations and import workflow
   - Explain intermediate state (still using markdown backend; importer prepares data for later backend swap)

## Solution

### CLI

`minsky tasks import-from-markdown [--execute] [--limit N] [--filter-status STATUS] [--json] [--reindex-embeddings]`

Behavior:

- Scan markdown tasks and spec files
- Normalize IDs and upsert into `tasks`
- On `--reindex-embeddings`, compute embeddings and write `embedding`, `dimension`, update `content_hash` and `last_indexed_at`

### Implementation Notes

- Use existing markdown parsing utilities to read tasks and specs
- Use the configuration-backed PG connection (sessiondb.postgres) for DB writes
- Use Drizzle for inserts/updates, respecting unique `task_id`
- Defer any backend switching; this task is import-only

## Considerations & Non-Goals

- Not introducing a `pg-tasks` backend in this task (tracked separately)
- No changes to user-facing task backend selection; markdown remains active
- No global test updates required in this task (will be done with backend introduction)
- Future GH Issues migration will build on having tasks in DB first

## Notes

- Follow persistence rules: schema-first, Drizzle Kit generated migrations, and `sessiondb migrate` for application (dry-run by default)

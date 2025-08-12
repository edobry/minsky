# Implement Drizzle Kit migrations for PostgreSQL SessionDB

## Context

Goal: Replace ad-hoc SQL/table creation in `src/domain/storage/backends/postgres-storage.ts` with proper Drizzle Kit migrations, ensuring full schema parity with SQLite and programmatic migration execution.

Scope:

- Generate Drizzle Kit migrations for PostgreSQL based on `src/domain/storage/schemas/session-schema.ts`.
- Ensure migrations create the `sessions` table with all required columns:
  - session, repo_name, repo_url, created_at, task_id, branch, repo_path
  - pr_branch, pr_approved, pr_state, backend_type, pull_request
- Wire migrations to run programmatically at startup using `drizzle-orm/postgres-js/migrator`.
- Remove manual `CREATE TABLE` and `ALTER TABLE` logic from `PostgresStorage.initialize()`.
- Align insert/read/update logic to use the Drizzle schema consistently (no raw SQL for inserts).
- Update Drizzle Kit config to include PostgreSQL dialect and migrations output path for pg.
- Add tests (bun:test) to verify:
  - Migrations apply cleanly on empty DB
  - Schema parity with SQLite (columns present and correct types)
  - Read/write round-trip for a sample `SessionRecord`

Non-Goals:

- Changing SQLite backend behavior
- Data transformation of existing rows beyond schema creation

Deliverables:

- New migration files under `src/domain/storage/migrations` (pg dialect)
- Updated `postgres-storage.ts` to rely on migrations only (no manual DDL)
- Tests validating schema and CRUD
- Documentation note in `docs/testing/` or `docs/architecture/` about pg migrations

Acceptance Criteria:

- Running the app on a clean PostgreSQL DB creates the correct schema via Drizzle migrations
- `minsky session list` works with pg backend without manual ALTER statements
- Tests pass on CI
- Manual SQL DDL removed from `PostgresStorage.initialize()`

Notes:

- Current stopgap uses `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE` adds; this task removes that in favor of Drizzle Kit
- Ensure `connectionString` is used consistently across config and backend factory

## Requirements

## Solution

## Notes

# Implement programmatic pending Drizzle migrations detection

## Status

TODO

## Context

Implement a programmatic, in-app way to detect pending Drizzle migrations without shelling out or applying them. Use drizzle-kit’s internal helpers to parse drizzle.config and establish connections, and drizzle-orm’s `readMigrationFiles` to compute pending vs applied. Provide a small library function and a CI-friendly script.

Reference: `docs_drizzle-migration-status.md`

## Requirements

### 1) Library function
   - Location: `src/db/checkPendingMigrations.ts`
   - API: `checkPendingMigrations(configPath?: string): Promise<{ totals: { files: number; applied: number; pending: number }, pending: Array<{ name: string; hash: string; sqlPreview: string }>, migrationsFolder: string, migrationsTable: string, migrationsSchema?: string, dialect: string }>`
   - Behavior:
     - Parse drizzle config via drizzle-kit internal `prepareMigrateConfig`
     - Create dialect-specific connection via drizzle-kit internal helpers
     - Read local migration files with `readMigrationFiles`
     - Query DB migrations table for applied hashes (handle "table not found" as zero applied)
     - Compare and return pending list with previews (truncated)

### 2) CLI/CI script
   - Location: `scripts/assert-no-pending-migrations.ts`
   - Behavior: exit non-zero if `pending > 0`, printing a concise list
   - Integrate with CI job as a pre-commit/pre-merge check (doc note)

### 3) Documentation
   - Add a short section to `docs/sessiondb-migration-guide.md` referencing the helper and the CI script
   - Explain risks of internal drizzle-kit imports; pin version and add smoke test

## Solution

### Implementation Notes

- Use internal drizzle-kit helpers (config + connections). Choose import paths based on our installed package layout.
- Use `readMigrationFiles` from drizzle-orm to parse local files.
- For PostgreSQL, respect optional `migrations.schema` (`public` default) and table name.
- For fresh DBs without the migrations table, treat as zero applied (safe default).
- Provide JSON-friendly structures for easy consumption by other systems.

### Detailed Design

- Config discovery
  - Input: optional `configPath` (defaults to project’s `drizzle.pg.config.ts`)
  - Use `prepareMigrateConfig(configPath)` to resolve:
    - `dialect` (postgresql | mysql | sqlite | libsql | singlestore)
    - `out` (migrations folder, e.g., `src/domain/storage/migrations/pg`)
    - `table` (migrations table, defaults to `__drizzle_migrations`)
    - `schema` (Postgres-only schema; default `public`)
    - `credentials` (driver credentials)

- DB connection
  - Postgres: `preparePostgresDB(cfg.credentials)`
  - MySQL: `connectToMySQL(cfg.credentials)`
  - SQLite: `connectToSQLite(cfg.credentials)`
  - libSQL: `connectToLibSQL(cfg.credentials)`
  - Return object exposes `query(sql, params?)`

- Read migration files
  - `readMigrationFiles({ migrationsFolder: cfg.out })` → returns `{ name, hash, sql }[]`
  - Note: `hash` is the source-of-truth identity used by drizzle-orm

- Read applied migrations
  - Build fully-qualified table ref:
    - Postgres: `"{schema}"."{table}"` (schema optional)
    - MySQL/SingleStore: \`{table}\`
    - SQLite/libSQL: `"{table}"`
  - Query: `SELECT hash FROM <tableRef> ORDER BY created_at` (ORDER BY optional)
  - If the table doesn’t exist, treat as zero applied (fresh DB)

- Compute pending
  - `pending = files.filter(f => !appliedHashes.has(f.hash))`
  - For each pending, include `{ name, hash, sqlPreview }`
    - `sqlPreview = (sql || '').slice(0, 120).replace(/\s+/g, ' ') + (sql.length > 120 ? '…' : '')`

- Output structure
  - `{ dialect, migrationsFolder, migrationsTable, migrationsSchema?, totals: { files, applied, pending }, pending }`

- Error handling
  - Wrap connection and query errors; rethrow unknown DB errors
  - Redact credentials in any thrown/logged messages

### CI Script

- `scripts/assert-no-pending-migrations.ts`
  - Calls `checkPendingMigrations()`
  - If `pending > 0`, print a summary and `process.exit(1)`
  - Else print `✅ No pending migrations` and exit 0

### Logging & Security

- Do not print full SQL for pending migrations in CI; only `sqlPreview`
- Redact connection strings when logging
- Pin `drizzle-kit` version; add smoke test to guard internal API changes

### Dialect Support

- Implement for Postgres first (default path)
- Also wire MySQL and SQLite/libSQL using the same pattern; tested against our CI only for Postgres now

### Integration Points

- Expose a tiny wrapper in `src/domain/storage/sessiondb-status.ts` to re-use this in `sessiondb migrate --dry-run` for better “pending filenames” UX
- Optionally add a subcommand `sessiondb status` that prints this structured result

## Notes

- Internal API caveat: pin `drizzle-kit` and add a smoke test
- No migration application is performed; status-only

## Acceptance Criteria

- [ ] `checkPendingMigrations()` returns accurate counts and filenames on a DB with: 0 pending, some pending, and fresh (no table)
- [ ] CI script exits non-zero when pending > 0 and prints concise list
- [ ] Works at least for Postgres in our environment; import paths documented for internal drizzle-kit helpers
- [ ] Docs updated in `docs/sessiondb-migration-guide.md` to reference the programmatic checker and CI script

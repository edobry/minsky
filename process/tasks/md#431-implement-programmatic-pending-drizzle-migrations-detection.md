# Implement programmatic pending Drizzle migrations detection

## Status

TODO

## Context

Implement a programmatic, in-app way to detect pending Drizzle migrations without shelling out or applying them. Use drizzle-kit’s internal helpers to parse drizzle.config and establish connections, and drizzle-orm’s `readMigrationFiles` to compute pending vs applied. Provide a small library function and a CI-friendly script.

Reference: `docs_drizzle-migration-status.md`

## Requirements

1. Library function
   - Location: `src/db/checkPendingMigrations.ts`
   - API: `checkPendingMigrations(configPath?: string): Promise<{ totals: { files: number; applied: number; pending: number }, pending: Array<{ name: string; hash: string; sqlPreview: string }>, migrationsFolder: string, migrationsTable: string, migrationsSchema?: string, dialect: string }>`
   - Behavior:
     - Parse drizzle config via drizzle-kit internal `prepareMigrateConfig`
     - Create dialect-specific connection via drizzle-kit internal helpers
     - Read local migration files with `readMigrationFiles`
     - Query DB migrations table for applied hashes (handle "table not found" as zero applied)
     - Compare and return pending list with previews (truncated)

2. CLI/CI script
   - Location: `scripts/assert-no-pending-migrations.ts`
   - Behavior: exit non-zero if `pending > 0`, printing a concise list
   - Integrate with CI job as a pre-commit/pre-merge check (doc note)

3. Documentation
   - Add a short section to `docs/sessiondb-migration-guide.md` referencing the helper and the CI script
   - Explain risks of internal drizzle-kit imports; pin version and add smoke test

## Solution

### Implementation Notes

- Use internal drizzle-kit helpers (config + connections). Choose import paths based on our installed package layout.
- Use `readMigrationFiles` from drizzle-orm to parse local files.
- For PostgreSQL, respect optional `migrations.schema` (`public` default) and table name.
- For fresh DBs without the migrations table, treat as zero applied (safe default).
- Provide JSON-friendly structures for easy consumption by other systems.

## Notes

- Internal API caveat: pin `drizzle-kit` and add a smoke test
- No migration application is performed; status-only

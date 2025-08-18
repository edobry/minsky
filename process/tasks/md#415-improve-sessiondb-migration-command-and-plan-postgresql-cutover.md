# Improve sessiondb migration command and plan PostgreSQL cutover

## Context

# Improve SessionDB migration command and plan PostgreSQL cutover

## Context

Improve the `minsky sessiondb migrate` command for a safe, config-driven migration to PostgreSQL, deprecate the legacy JSON file SessionDB backend, and perform the actual migration plan/cutover. Focus on safety, reversibility, and minimizing data drift.

Goals:

- Deprecate JSON file SessionDB backend and warn on usage (read-only compatibility for migration/backup only)
- Make dry-run the default behavior for migration
- Always back up before migrating (SQLite file copy + JSON dump)
- Remove `--connection-string`; require config-driven Postgres (config/env resolution)
- Add strong preflight validations (also in dry-run)
- Add `--set-default` with clear reversal instructions
- Warn when runtime backend differs from configured backend to reduce drift
- Fix `sessiondb check` to delegate to the appropriate backend automatically

Requirements:

1. Deprecate JSON SessionDB Backend

- Add deprecation warnings if `sessiondb.backend: "json"` is detected
- Update docs
- Keep read-only compatibility for migration/backup

2. Migration Command UX Changes

- Default to `--dry-run=true`
- Always perform backups: copy SQLite DB file + JSON dump (timestamped)
- Remove `--connection-string`; resolve Postgres connection via configuration/env only
- Add `--set-default`: on success, update config to `backend: postgres` and show reversal steps

3. Preflight Validations (run in dry-run and real run)

- Validate source SQLite readability
- Validate backup locations (writable, disk space)
- Validate Postgres connectivity using configured connection
- Validate migrations/schemas can be applied (idempotent, permissions)
- Validate constraints/uniqueness compatibility
- Emit a clear summary of planned changes

5. SessionDB Check Delegation (Backend-Aware)

- Update `minsky sessiondb check` to auto-detect current backend and run the right checks:
  - JSON/SQLite: file-based integrity checks (structure, readability, corruption hints)
  - PostgreSQL: connectivity, permissions, schema/migration readiness, extension availability
- Respect `--backend` to override auto-detection but do not require `--file` for Postgres
- Report which backend and source were used (file path for JSON/SQLite; connection target for Postgres)

4. Drift and Safety Controls

- In SessionDB provider/adapter, warn if active storage backend differs from configured backend

Non-Goals:

- Building a bidirectional sync engine
- Supporting JSON as an ongoing primary backend

CLI Examples:

- `minsky sessiondb migrate to postgres` (dry run default)
- `minsky sessiondb migrate to postgres --dry-run=false`
- `minsky sessiondb migrate to postgres --dry-run=false --set-default`
- `minsky sessiondb check --report` # Auto-detects backend; file checks for JSON/SQLite, connectivity/schema checks for Postgres
- `minsky sessiondb check --backend postgres --report` # Forces Postgres checks even if files exist

## Requirements

## Solution

## Notes

## Requirements

## Solution

## Notes

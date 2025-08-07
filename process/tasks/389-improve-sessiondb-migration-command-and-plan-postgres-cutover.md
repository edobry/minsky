# Improve SessionDB Migration Command and Plan PostgreSQL Cutover

## Status

BACKLOG

## Priority

HIGH

## Description

This task improves the `minsky sessiondb migrate` command for a safe, config-driven migration to PostgreSQL, deprecates the legacy JSON file SessionDB backend, and performs the actual migration plan/cutover. The focus is on safety, reversibility, and minimizing data drift.

## Goals

- Deprecate JSON file SessionDB backend and warn on usage
- Make dry-run the default behavior for migration
- Always back up before migrating (SQLite file copy + JSON dump)
- Remove `--connection-string`; require config-driven Postgres
- Add strong preflight validations (also in dry-run)
- Add `--set-default` with clear reversal instructions
- Warn when runtime backend differs from configured backend

## Requirements

### 1. Deprecate JSON SessionDB Backend
- Add deprecation warnings if `sessiondb.backend: "json"` is detected
- Update docs to indicate JSON backend is deprecated and unsupported going forward
- Keep read-only compatibility for migration/backup purposes only

### 2. Migration Command UX Changes
- Default to `--dry-run=true`
- Always perform backups:
  - Copy the SQLite database file to a timestamped backup path
  - Create a JSON dump of sessions to a timestamped backup path
- Remove `--connection-string`; resolve Postgres connection via configuration/env only
- Add `--set-default` flag:
  - On success, update `.minsky/config.yaml` or user config to `backend: postgres`
  - Show reversal instructions (how to switch back to SQLite)

### 3. Preflight Validations (run in both dry-run and real run)
- Validate current backend readability (SQLite open + simple query)
- Validate backup locations are writable and space is sufficient
- Validate Postgres connectivity using configured connection
- Validate Postgres schema/migrations can be applied (no-op migration if already applied)
- Validate permission to create/alter table(s)
- Validate uniqueness/constraints compatibility
- Emit a clear summary of what will change

### 4. Drift and Safety Controls
- Add runtime check in SessionDB provider/adapter:
  - If active storage backend differs from configured backend, log a prominent warning
  - Include hint to run `minsky sessiondb migrate` or update config

## Non-Goals
- Building a bidirectional sync engine
- Supporting JSON as an ongoing primary backend

## Implementation Plan

1. CLI and MCP Layer
   - Update `sessiondb.migrate` parameters: remove `connectionString`; add `setDefault` (boolean)
   - Default `dryRun` to true
   - Enforce backups; record backup paths in output
   - Resolve Postgres connection from config/env

2. Preflight Validator
   - Implement a reusable validator for:
     - Source SQLite integrity/readability
     - Backup viability (paths, disk space)
     - Postgres connectivity + migration readiness
     - Schema compatibility checks

3. Storage Layer
   - Ensure Postgres storage initialization applies migrations idempotently
   - Add helper to test privileges (create table/temp table if allowed)

4. Deprecation Warnings
   - On configuration load, if `sessiondb.backend === "json"` → log deprecation warning with migration guidance
   - Update docs

5. Backend Drift Warning
   - In `SessionDbAdapter` (or equivalent provider), compare configured backend vs active storage backend; warn if different

6. Cutover Procedure (Documentation + Command Output)
   - Guidance for `--set-default`
   - Reversal steps (how to switch back, and how to restore from backups)

## CLI Examples

```
# Dry run is default; shows preflight checks, planned actions, and backup locations
minsky sessiondb migrate to postgres

# Perform migration, keep config unchanged
minsky sessiondb migrate to postgres --dry-run=false

# Migrate and set Postgres as default backend (with reversal instructions)
minsky sessiondb migrate to postgres --dry-run=false --set-default
```

## Success Criteria

- Dry-run by default; real run requires explicit `--dry-run=false`
- Backups always created (SQLite file copy + JSON dump)
- Migration reads config for Postgres; no `--connection-string` flag exists
- Deprecation warning shown if JSON backend is configured
- Drift warnings emitted when runtime and configured backends differ
- Comprehensive preflight validation runs for both dry-run and real run

## Risks

- Misconfigured Postgres may block migration → mitigated by preflight validation
- Config file write failures on `--set-default` → mitigated by fallbacks and clear instructions
- Large SQLite databases → ensure streaming JSON dump and efficient file copy

## Follow-Ups

- Consider an interactive TUI mode to step through migration
- Add telemetry (opt-in) for migration success/failure to improve guidance



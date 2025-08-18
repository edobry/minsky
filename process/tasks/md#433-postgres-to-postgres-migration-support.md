# Plan: Support Postgres→Postgres SessionDB Migration

## Context

We currently support:

- Data migration between different backends via `minsky sessiondb migrate --to <backend>`
- Schema migrations for the configured backend when `--to` is omitted

We do not yet support migrating data directly between two named PostgreSQL instances (e.g., different URLs/DBs).

## Goal

Enable Postgres→Postgres data migration with explicit source and target connection strings, including:

- Dry-run planning and counts
- Target schema preparation (Drizzle migrator)
- Full data copy with chunking/transaction boundaries
- Masked connection strings in logs

## Proposed CLI

```bash
# Preview
minsky sessiondb migrate --from-postgres "postgres://user:pass@hostA/dbA" --to-postgres "postgres://user:pass@hostB/dbB" --dry-run

# Execute
minsky sessiondb migrate --from-postgres "postgres://..." --to-postgres "postgres://..." --execute

# Verbose
minsky sessiondb migrate --from-postgres "postgres://..." --to-postgres "postgres://..." --execute --verbose
```

## Behaviors

- Validate both connections (connectivity only; minimal schema checks)
- Run Drizzle migrations on target before copy
- Copy sessions in batches (e.g., 1k) inside transactions
- Idempotency: replace target sessions by primary key
- Progress reporting: counts per batch

## Safety

- Default to preview unless `--execute`
- Mask credentials in output
- Optional `--backup-target` to JSON snapshot (future)

## Implementation Notes

- Use `drizzle-orm/postgres-js` and migrator
- Keep implementation in `sessiondb.ts` near existing migrate logic for reuse
- Share read/write adapters already used for config-driven backends

## Open Questions

- Do we need partial copy filters? (by taskId or date range)
- Performance expectations and indexes

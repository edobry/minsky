# Persistence Migration Guide

> **Renamed from "SessionDB".** The `sessiondb` CLI namespace was retired when sessions moved
> onto the Postgres-only `DrizzleSessionRepository` (mt#2339, mt#2329) — there is no `minsky sessiondb`
> command anymore. The current command family is `minsky persistence`. Postgres is
> the **only** supported backend ([ADR-018](architecture/adr-018-domain-persistence-pattern.md),
> [ADR-027](architecture/adr-027-postgres-only-persistence-confirmed.md)); SQLite and the older
> JSON-file backend have been removed entirely, not merely deprecated. See
> [§Historical](#historical-pre-mt2339-sqlite--json-migration) for what this guide used to cover.

This guide covers the current Postgres persistence surface: configuring the connection, applying
schema migrations, and restoring session data from a JSON backup. For connection-pool sizing,
retry behavior, and graceful shutdown, see
[Postgres Persistence Configuration](./persistence-configuration.md). For diagnosing a broken or
degraded connection, see the [Troubleshooting Guide](./sessiondb-troubleshooting.md).

## Configuration

Persistence is configured under the `persistence` key in `.minsky/config.yaml` (repository) or
`~/.config/minsky/config.yaml` (global):

```yaml
persistence:
  backend: postgres
  postgres:
    connectionString: "postgresql://user:password@host:5432/minsky"
    maxConnections: 15
```

`backend` accepts only `postgres` — the type itself has no other member (mt#2339).
`maxConnections` is optional — the built-in default is derived from the pooler's client budget (the
`15` above is an explicit override, not the default). The derived value moves whenever the measured
inputs move, so it is deliberately NOT restated here; see
[Postgres Persistence Configuration](./persistence-configuration.md) for the current number, the
derivation table, and the command that re-checks it.
Equivalent environment variables:

| Variable                                      | Config key                                     | Notes                                                   |
| --------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| `MINSKY_PERSISTENCE_BACKEND`                  | `persistence.backend`                          | Canonical                                               |
| `MINSKY_PERSISTENCE_POSTGRES_URL`             | `persistence.postgres.connectionString`        | Canonical                                               |
| `MINSKY_POSTGRES_URL`                         | `persistence.postgres.connectionString`        | Legacy alias, still read                                |
| `MINSKY_POSTGRES_SESSION_URL`                 | `persistence.postgres.sessionConnectionString` | Session-mode pooler URL for `LISTEN`/`NOTIFY` (mt#1852) |
| `MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT` | `persistence.postgres.connectTimeout`          | Seconds                                                 |

Inspect the effective, merged configuration at any time:

```bash
minsky config get persistence.backend
minsky config get persistence.postgres.connectionString
minsky config list --sources
```

If no connection string is configured anywhere, Minsky boots with a placeholder
"unconfigured" persistence provider — non-DB commands (`--version`, `config get`, `/health`)
keep working, but any DB-backed operation fails with:

```
Persistence is not configured: ... This operation requires a Postgres connection. Set
persistence.postgres.connectionString in config, or export MINSKY_PERSISTENCE_POSTGRES_URL
(or legacy MINSKY_POSTGRES_URL).
```

## Schema migrations

`minsky persistence migrate` with **no target argument** runs the Drizzle schema migrations for
the configured Postgres backend. This is the day-to-day form of the command — it's what a fresh
clone or a cold-started deployment runs to bring the database schema up to date.

```bash
# Preview pending migrations (default — no changes made)
minsky persistence migrate

# Apply pending migrations
minsky persistence migrate --execute
```

Sample output in preview mode:

```
Schema migration (dry run) for postgres
```

The migrations folder is resolved automatically for both source-tree and bundled-binary
invocations (mt#2369) — see
[Migration Folder Resolution](./persistence-configuration.md#migration-folder-resolution-bundle-aware-mt2369)
if you need the resolution order.

### Unmerged-migration guard

Applying a migration (`--execute`) against a shared/remote database refuses to proceed if the
pending migration's `.sql` file isn't present on `origin/main` yet — this prevents a
feature-branch-only migration from being applied to production and then abandoned. Full detail,
including the override flag: [Migration Safety: Unmerged-Migration Guard](./persistence-configuration.md#migration-safety-unmerged-migration-guard-mt2277).

## Restoring session data from a JSON backup

`minsky persistence migrate to postgres` reads session records and writes them into the
Postgres `sessions` table as a **full replacement** (existing rows are cleared first, inside one
transaction). `to` accepts only `postgres` — there is no other valid target.

```bash
# Preview: read a JSON backup and show what would be written (default mode)
minsky persistence migrate to postgres --from ./backups/session-backup-2026-06-01.json

# Apply it, creating a fresh backup of the current Postgres state first
minsky persistence migrate to postgres \
  --from ./backups/session-backup-2026-06-01.json \
  --execute
```

If `--from` is omitted, the source is the currently configured backend (already Postgres), so
the command re-reads and re-writes the live table — useful mainly as a "verified full rewrite"
operation, not a cross-backend migration.

| Option          | Description                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `to`            | Target backend argument; only `postgres` is accepted                                                                                                                           |
| `--from <path>` | Read source sessions from a JSON backup file instead of the live DB                                                                                                            |
| `--backup`      | Write a JSON backup of the source before migrating (default: true)                                                                                                             |
| `--execute`     | Actually perform the migration (default is preview mode)                                                                                                                       |
| `-n, --dry-run` | Force preview mode. Takes precedence over `--execute`, so `--dry-run --execute` previews rather than applies. Applies to both schema-only mode and backend migration (mt#3191) |
| `--debug`       | Enable debug output                                                                                                                                                            |

Legacy session records without a `taskId` are skipped and reported in the operation summary —
this is a carryover safeguard from the original JSON-backend migration path, not something that
occurs with normal Postgres-native sessions.

## Troubleshooting

Connection failures, authentication errors, and schema-drift issues are covered in the
[Troubleshooting Guide](./sessiondb-troubleshooting.md). Pool exhaustion and retry behavior are
covered in [Postgres Persistence Configuration](./persistence-configuration.md).

## Historical: pre-mt#2339 SQLite / JSON migration

Before mt#2339 (SQLite backend removal) and mt#2329 (sessions moved off the JSON/SQLite-capable
`DatabaseStorage`), this guide documented migrating session data between a legacy JSON-file
backend, a SQLite backend (`[sessiondb]` TOML config, `sqliteOptions`, `sqlite3` recovery
commands), and PostgreSQL. None of that command surface exists anymore — `sessiondb.*` config
keys throw at boot, and no `sqlite`-target value is accepted by any current command. See
[ADR-018](architecture/adr-018-domain-persistence-pattern.md) for why SQLite was removed rather
than kept as a secondary backend, and mt#434 for the deferred PGlite (embedded Postgres) option
some of that local-database use case may eventually cover.

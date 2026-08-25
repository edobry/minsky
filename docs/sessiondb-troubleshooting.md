# Persistence Troubleshooting Guide

> **Renamed from "SessionDB troubleshooting".** Postgres is the **only** supported persistence
> backend ([ADR-018](architecture/adr-018-domain-persistence-pattern.md),
> [ADR-027](architecture/adr-027-postgres-only-persistence-confirmed.md)) — SQLite has been
> removed entirely (mt#2339, mt#2329), not merely deprecated. There is no `minsky sessiondb`
> command; the current command family is `minsky persistence`. See
> [§Historical](#historical-sqlite-issues-pre-mt2339) for what this guide used to cover.

This guide covers diagnosing and resolving Postgres persistence issues. For migrating data or
running schema migrations, see the [Migration Guide](./sessiondb-migration-guide.md). For
connection-pool sizing, retry policy, and graceful-shutdown behavior, see
[Postgres Persistence Configuration](./persistence-configuration.md).

## Quick Diagnostics

```bash
# Check backend health: connectivity + schema-drift audit
minsky persistence check --report

# List sessions (verify the DB is actually readable)
minsky session list --verbose

# Inspect the effective persistence configuration and where it came from
minsky config get persistence.backend --sources
minsky config get persistence.postgres.connectionString --sources
minsky config list
```

`minsky persistence check` runs a read-only connectivity test (`SELECT 1`) plus the
[schema-drift audit](#schema-drift-audit-postgres) below, and reports `success: false` with
`issues[]`/`suggestions[]` when either fails — pass `--report` to print the full result even on
success.

## Common Issues

### `Connection refused` / `ECONNREFUSED`

**Symptoms:**

```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Causes:** Postgres isn't running, wrong host/port, or a firewall is blocking the connection.

**Solutions:**

```bash
# Is Postgres reachable at all?
pg_isready -h <host> -p 5432

# Can you connect with the exact configured connection string?
psql "$(minsky config get persistence.postgres.connectionString)" -c "SELECT 1;"
```

### `password authentication failed`

**Symptoms:**

```
Error: password authentication failed for user "minsky_user"
```

**Causes:** Wrong credentials, the user doesn't exist, or an auth-method mismatch.

**Solutions:** verify the connection string's credentials, then update it:

```bash
minsky config set persistence.postgres.connectionString "postgresql://correct_user:correct_pass@host:5432/db"
# or, without touching the config file:
export MINSKY_PERSISTENCE_POSTGRES_URL="postgresql://correct_user:correct_pass@host:5432/db"
```

### `relation "sessions" does not exist` (or any other table)

**Symptoms:**

```
Error: relation "sessions" does not exist
```

**Causes:** the schema hasn't been migrated yet on this database, or the connection string
points at the wrong database.

**Solutions:**

```bash
# Apply pending schema migrations
minsky persistence migrate --execute

# Confirm you're pointed at the intended database
psql "$(minsky config get persistence.postgres.connectionString)" -c "\dt"
```

### Persistence not configured at boot

**Symptoms:** any DB-backed command fails with:

```
Persistence is not configured: ... This operation requires a Postgres connection. Set
persistence.postgres.connectionString in config, or export MINSKY_PERSISTENCE_POSTGRES_URL
(or legacy MINSKY_POSTGRES_URL).
```

Minsky boots successfully without a configured connection (non-DB commands like `--version` and
`config get` still work) but fails on first DB use. Set
`persistence.postgres.connectionString` in `.minsky/config.yaml` / `~/.config/minsky/config.yaml`,
or export `MINSKY_PERSISTENCE_POSTGRES_URL`, then retry.

### Connection pool saturation

**Symptoms:** intermittent `[retry N/3] ...: pg pool saturation` warnings in logs, or a hard
failure after 3 retry attempts.

This has a dedicated retry policy and diagnostic log signature — see
[Connection-Exhaustion Retry Policy](./persistence-configuration.md#connection-exhaustion-retry-policy)
for the full mechanism, and
[Overriding the Pool Size](./persistence-configuration.md#overriding-the-pool-size) to change how
many connections one process opens.

**Different symptom, different mechanism:** DB-backed calls that HANG rather than fail, while a CLI
DB read returns promptly, are this process's own pool being full — not the pooler refusing it. Since
mt#4473 that produces a bounded `EPOOLADMISSIONTIMEOUT` refusal instead of an indefinite wait; see
[In-process admission bound](./persistence-configuration.md#in-process-admission-bound-mt2773-extended-mt4473)
for how to read the saturation counters and what to do about it.

## Schema-drift audit (Postgres)

`minsky persistence check` runs a **read-only schema-drift audit** on the Postgres backend
(mt#1641). It exists because the drizzle migration ledger (`drizzle.__drizzle_migrations`)
records migrations by hash with no post-apply schema verification — so a manual `DROP COLUMN`
or a migration that was tracked-applied without its `CREATE TABLE` ever running leaves the
ledger looking clean while the live schema diverges. The audit compares the **declared
schema (drizzle models)** against the **actual database** and reports:

- **Missing table** — a declared table absent from the DB (e.g. a tracked-but-never-created
  table).
- **Missing column** — a declared column absent from an existing table (e.g. a manual
  `DROP COLUMN`).
- **Extra column** — a DB column not present in the model (un-modeled column / pending model
  update).
- **Duplicate ledger row** — a migration recorded more than once in
  `drizzle.__drizzle_migrations` (inflates the applied count and trips the migrate
  count-check).

It is **read-only** — it never modifies the database; findings surface as issues/suggestions
in the `persistence check` output. v1 covers the embeddings tables; a clean run logs
`✅ Schema-drift audit clean`. Reconciling reported drift (recreating a table, recording a
manual drop as a migration, or de-duplicating a ledger row) is a deliberate, separate
operation — never performed by the audit.

## Getting Help

Before reporting an issue, collect this diagnostic information:

```bash
minsky --version
minsky config list --sources
minsky persistence check --report
minsky session list --verbose --limit 5
```

Include the command output (with the connection string's credentials redacted —
`persistence check` already masks them in its own log lines), your OS, and the steps to
reproduce.

## Historical: SQLite issues (pre-mt#2339)

Before mt#2339 (SQLite backend removal), this guide covered SQLite-specific failures
(`SQLITE_BUSY`, `SQLITE_CORRUPT`, `SQLITE_READONLY`), their error-code table, `sqlite3`-based
recovery procedures (`.recover`, `PRAGMA integrity_check`), and the `sessiondb.sqliteOptions`
config keys (`journalMode`, `synchronous`, `cacheSize`). None of that applies to the current
codebase: SQLite is not a selectable backend, `sessiondb.*` config keys throw at boot, and no
`sqlite3` command is part of any supported Minsky workflow. See
[ADR-018](architecture/adr-018-domain-persistence-pattern.md) for why SQLite was removed rather
than kept as a secondary backend.

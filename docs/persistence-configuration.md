# Postgres Persistence Configuration

This document covers the runtime behavior of the Postgres persistence backend introduced in
mt#1193: connection pool sizing, connection-exhaustion retry policy, and MCP graceful shutdown.
For migrating between backends, see [SessionDB Migration Guide](./sessiondb-migration-guide.md).
For common Postgres errors, see [SessionDB Troubleshooting Guide](./sessiondb-troubleshooting.md).

## Connection Pool Size

### Default

Each Minsky process opens a postgres-js connection pool with a **default maximum of 3 connections**.
This is intentionally small. Minsky is designed to run as multiple concurrent processes (for
example, a laptop MCP server and a Railway-hosted MCP server) all sharing the same
Supabase/Supavisor session-mode pooler. A large per-process limit would quickly saturate the
pooler's global connection ceiling.

### Overriding the Pool Size

The pool size is resolved in priority order (highest wins):

1. **Config file** — `persistence.postgres.maxConnections` in `.minsky/config.yaml` or
   `~/.config/minsky/config.yaml`
2. **Environment variable** — `MINSKY_POSTGRES_MAX_CONNECTIONS`
3. **Built-in default** — 3

Example config override:

```yaml
persistence:
  backend: postgres
  postgres:
    connectionString: "postgresql://user:pass@host/db"
    maxConnections: 5
```

Example environment override:

```bash
export MINSKY_POSTGRES_MAX_CONNECTIONS=5
```

**Valid range:** 1–100. Values outside this range behave as follows:

- Non-positive values (0, negative, non-numeric) are **silently ignored** — the next source in
  the precedence chain is tried (env falls back to default; config falls back to env or default).
- Values above 100 are **clamped** to 100 with a warning log:
  `maxConnections (N) exceeds upper bound (100); clamping to prevent pooler saturation`

### `PostgresStorage.maxConnections` is informational

The `PostgresStorageConfig.maxConnections` field (used when constructing `PostgresStorage`
directly) is **informational only**. `PostgresStorage` reuses the connection pool opened by
`PostgresPersistenceProvider` — it does not open its own sockets. The pool size that matters is
the one set on the provider via the config key or env var described above.

## Connection-Exhaustion Retry Policy

When Supavisor (session-mode pooler), PgBouncer, or Postgres itself rejects a new connection
because the pool is full, Minsky retries the operation automatically rather than failing
immediately.

### Conditions that trigger a retry

A connection failure is retried if any of the following match:

| Condition                                                            | Detail                                              |
| -------------------------------------------------------------------- | --------------------------------------------------- |
| SQLSTATE `53300`                                                     | Standard Postgres "too many connections" error code |
| Message matches `max clients reached` (case-insensitive)             | Supavisor session-mode pooler rejection             |
| Message matches `sorry, too many clients already` (case-insensitive) | PgBouncer rejection                                 |
| Message matches `too_many_connections` (case-insensitive)            | Postgres error name variant                         |

Retries are only triggered for **connection-acquisition** failures (before any query reaches the
server). Errors that arrive after a query has been transmitted are not retried, ensuring no
operation is executed more than once.

### Retry schedule

| Attempt | Wait before next attempt (±20% jitter) |
| ------- | -------------------------------------- |
| 1 → 2   | ~150 ms (range: 120–180 ms)            |
| 2 → 3   | ~300 ms (range: 240–360 ms)            |
| 3       | Error is raised; no further retry      |

Maximum attempts: **3** (the first attempt plus two retries).

The ±20% jitter spreads simultaneous retries from concurrent callers to prevent all processes from
hammering the pooler at the same instant (thundering herd).

### Log signature

When a retry fires, a `WARN`-level log is emitted with this format:

```
[retry N/M] <label>: pg pool saturation (code=<code>): <error message> — retrying in <ms>ms
```

For example:

```
[retry 1/3] postgres-storage.readState: pg pool saturation (code=53300): too many connections — retrying in 163ms
[retry 2/3] postgres-storage.readState: pg pool saturation (code=53300): too many connections — retrying in 271ms
```

If you see `[retry 2/3]` in your logs, the third attempt is the final one. If that attempt also
fails, the error is propagated to the caller.

To investigate persistent pool saturation:

1. Check how many Minsky MCP processes are running and their per-process pool size (default 3).
2. Check the Supabase/Supavisor pooler's global connection limit.
3. Consider reducing `maxConnections` per process or restarting idle MCP servers.

## MCP Graceful Shutdown

When the MCP server process receives **SIGTERM** (the normal shutdown signal on Linux/Docker, sent
during Railway redeploys and `docker stop`), it runs the following sequence before exiting:

1. **Drain in-flight requests** — waits for any tool calls currently executing to complete (with a
   timeout).
2. **Close DB connections** — calls `persistence.close()`, which sends a TCP FIN to the Postgres
   server and releases pooler slots immediately.
3. **Exit** — calls `process.exit(0)`.

The same cleanup runs on **SIGINT** (Ctrl+C).

### Why this matters for redeploys

Without explicit connection closing, Postgres-side sockets remain open until TCP keepalive timeout
(minutes). During a rolling redeploy on Railway (or any platform that starts a new container
while the old one drains), the old container's open connections count against the pooler's global
ceiling. The new container then hits pool saturation and must wait or retry.

Graceful shutdown fixes this: the old container releases its slots before the new container
starts, so the new container connects cleanly.

### Observing shutdown

Enable `DEBUG` logging (`MINSKY_LOG_LEVEL=debug`) to see the shutdown sequence:

```
[persistence] PostgreSQL connections closed
```

If you see this line, the connection was released cleanly. If the process was killed with SIGKILL
(which bypasses signal handlers), you will not see this line and connections will remain open
until Postgres times them out.

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

## Saturation Integration Tests

The files `tests/integration/postgres-pool-saturation.shared.ts` and
`tests/integration/postgres-pool-saturation.supabase.integration.test.ts` provide an end-to-end
harness that exercises `withPgPoolRetry` against a **real** Supavisor pool, validating the retry
path encounters genuine `XX000 "max clients reached"` errors (not synthetic ones produced by unit
tests).

Four acceptance tests are covered (mt#1205):

1. **Concurrent retry** — `poolSize + 5` clients race to connect; all eventually succeed and at
   least one retry is observed.
2. **CRUD idempotency** — a mutating `INSERT … ON CONFLICT DO NOTHING` issued concurrently from
   saturated clients produces exactly one row.
3. **Provider recovery** — `PostgresPersistenceProvider.initialize()` succeeds after pool
   saturation resolves; `getConnectionInfo()` shows `"connected"`.
4. **Vector search backoff** — `PostgresVectorStorage.search()` returns results under saturation
   (skipped gracefully when `pgvector` is not installed on the branch).

### Provisioning a Supabase Preview Branch

1. **Via the Supabase dashboard** — open your project, go to _Branches_, click _Create branch_,
   and select _Micro Compute_ as the compute size. The Micro Compute tier uses a Supavisor
   session-mode pool with `pool_size = 15` by default.

2. **Via the Supabase MCP tool** (if connected in your agent session):

   ```
   mcp__supabase__create_branch(name: "saturation-test")
   ```

   The branch inherits the project's compute tier. No API to override `pool_size` at branch
   creation time — the Micro Compute default of 15 is the intended target for these tests.

3. **Get the connection string** — in the dashboard, go to _Project Settings → Database → Connection
   string_ and select the **Session mode** (port 5432) pooler URL for your branch. It looks like:

   ```
   postgresql://postgres.PROJECT_REF:PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres
   ```

### Running the Tests

Set the required environment variables and run:

```bash
export RUN_INTEGRATION_TESTS=1
export SUPABASE_INTEGRATION_BRANCH_URL="postgresql://postgres.xxx:PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres"

# Optional: override if your branch has a non-default pool_size
# export SUPABASE_INTEGRATION_BRANCH_POOL_SIZE=15

bun test --preload ./tests/setup.ts --timeout=60000 \
  tests/integration/postgres-pool-saturation.supabase.integration.test.ts
```

When either env var is absent the file produces **zero tests and zero failures** — the gate is
the critical contract that keeps this file safe to include in a broad `bun test` run.

### Cost

| Resource               | Rate          | Estimate                                             |
| ---------------------- | ------------- | ---------------------------------------------------- |
| Supabase Micro Compute | $0.01344 / hr | ~$10 / mo (always-on branch)                         |
| Ephemeral CI branch    | $0.01344 / hr | Sub-dollar / mo for typical nightly or on-label runs |

An always-on saturation branch costs roughly $10/mo. For CI usage where the branch is created and
destroyed per run, the cost is negligible (a few cents per month at typical nightly cadence).
Delete the branch via the dashboard or `mcp__supabase__delete_branch` when no longer needed.

## Local Raw-Postgres Saturation Harness (mt#1365)

`tests/integration/postgres-pool-saturation.testcontainer.integration.test.ts` provides the
**durable contract test** for the pool-saturation retry path: a single Postgres container
(`pgvector/pgvector:pg16`) started with `max_connections = 10`, managed by Testcontainers, with
the same `runSaturationSuite` helper from mt#1364 driving the four acceptance tests against the
container's connection string. The shared helper holds 8 long-lived clients to consume the
ceiling and races 13 more that must retry — saturation is guaranteed even with a few
connections taken by Postgres background workers (autovacuum, superuser-reserved slots).

### Why this exists alongside the Supabase harness

`isPgPoolExhaustionError` matches three pooler error shapes:

| Shape                               | Source                                         | End-to-end coverage                         |
| ----------------------------------- | ---------------------------------------------- | ------------------------------------------- |
| `SQLSTATE 53300`                    | Raw Postgres (any deployment)                  | **THIS file** (mt#1365 — durable)           |
| `XX000 "max clients reached"`       | Supavisor (currently fronts our prod Postgres) | mt#1364 (Supabase branch — vendor-specific) |
| `"sorry, too many clients already"` | PgBouncer                                      | Unit tests only (not in our prod path)      |

The Supabase harness always has Supavisor in front, so it never produces the bare `53300` shape.
This harness is the only place we exercise that path against a real driver. It also stays valid
regardless of which managed Postgres host Minsky uses — `53300` is a stable Postgres protocol
error, not a vendor-specific message. If/when Minsky migrates off Supabase, mt#1364 should be
retired or repointed at the new pooler; this file stays put.

### Requirements

- A reachable docker daemon (Testcontainers handles container lifecycle from inside the test).
- No external credentials, no per-run cost.

### Run

The dedicated script handles env vars and the longer timeout this test needs:

```bash
bun run test:integration:docker
```

Or manually:

```bash
RUN_INTEGRATION_TESTS=1 RUN_TESTCONTAINER_TESTS=1 \
  bun test --preload ./tests/setup.ts --timeout=180000 \
    tests/integration/postgres-pool-saturation.testcontainer.integration.test.ts
```

### Two-level gate

Unlike `mt#1364`'s Supabase wrapper (one env var), this test sits behind **two** env vars:
`RUN_INTEGRATION_TESTS=1` AND `RUN_TESTCONTAINER_TESTS=1`. Both must be set for the file to
register any tests; otherwise it produces zero tests and zero failures.

The second gate exists because container-based tests have stricter preconditions than other
integration tests — they need a Docker daemon, and first-time image pull can exceed the default
30s `test:integration` timeout by minutes. The dedicated `test:integration:docker` script uses
`--timeout=180000` to give bun:test enough headroom for the test bodies after container startup.
Sitting behind a second sentinel keeps the standard `bun run test:integration` script free of
this Docker requirement.

If both env vars are set but the Docker daemon is unreachable, container start throws with a
clear error rather than silently passing — silent passes on missing infra are a false-negative
class we explicitly avoid.

### Lifecycle

A top-level `await` starts the container and computes the connection string; the file then
registers a `describe` block whose `afterAll` stops the container. Container startup happens
outside Bun's per-test timeout. With the no-op wait strategy, Testcontainers'
`withStartupTimeout(120_000)` effectively bounds only the docker exec/socket calls — the wait
strategy itself returns immediately. The real readiness deadline is the **60-second SQL probe
loop** that runs after `start()` returns (described in the compatibility note below); that probe
is what guarantees we don't move on to test execution against a non-ready Postgres. The
`test:integration:docker` script uses `--timeout=180000` to give bun:test enough headroom for
the test bodies after startup. Testcontainers handles cleanup automatically and reaps orphaned
containers via Ryuk on next start if a previous run was killed mid-flight.

### Bun + Testcontainers compatibility note

Testcontainers is primarily validated on Node.js. Under Bun, **all built-in wait strategies hang
indefinitely**: both the default `Wait.forListeningPorts()` and the implicit log-based strategy
(`/.*Started.*/`) use Docker socket polling or stream reading that never fires a completion
callback under Bun's runtime.

**Resolution (implemented in mt#1463):** The test uses a no-op `WaitStrategy` that resolves
immediately, bypassing all testcontainers readiness machinery. After `start()` returns, the test
performs its own SQL-level readiness probe using postgres-js: it attempts `SELECT 1` in a
500 ms retry loop with a 60-second deadline. This is the canonical Postgres readiness check and
gives stronger guarantees than TCP port-listening anyway (SQL-level proof the server accepts
queries, not just that it's listening).

The `bun run test:integration:docker` script works correctly with this approach. If Testcontainers
ever fixes its Bun compatibility, the no-op strategy and SQL probe can be replaced with
`.withWaitStrategy(Wait.forListeningPorts())` again — but the SQL probe is arguably superior so
there is no strong reason to revert.

### Choosing a harness

| Scenario                                                 | Harness                           |
| -------------------------------------------------------- | --------------------------------- |
| CI on every commit (no Supabase credentials)             | mt#1365 (Testcontainers)          |
| Authoritative production-shape verification              | mt#1364 (Supabase preview branch) |
| Catch raw-Postgres `53300` regressions                   | mt#1365                           |
| Catch Supavisor `XX000` regressions                      | mt#1364                           |
| Quick local iteration on the saturation tests themselves | mt#1365 (no provisioning step)    |
| Verify against the actual production pooler              | mt#1364                           |

Both harnesses share the same `runSaturationSuite` helper, so adding a new acceptance test
covers both backends with one change. Convergent results across both is the strongest signal
that the retry path behaves correctly.

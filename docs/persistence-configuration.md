# Postgres Persistence Configuration

This document covers the runtime behavior of the Postgres persistence backend introduced in
mt#1193: connection pool sizing, connection-exhaustion retry policy, and MCP graceful shutdown.
For migrating between backends, see [SessionDB Migration Guide](./sessiondb-migration-guide.md).
For common Postgres errors, see [SessionDB Troubleshooting Guide](./sessiondb-troubleshooting.md).

## Behavior When Initialization Fails at Boot (mt#3636)

If a Postgres connection string is configured but `initialize()` fails at startup — DNS failure,
unreachable host, bad credentials, a migration error — the process **still boots**, so `/health`
and non-DB commands keep working (mt#2349). DI substitutes `UnconfiguredPersistenceProvider`, whose
capability flags are all `false` and whose every DB accessor throws.

### The data plane fails closed

**Every DB-backed read raises; none returns an empty or not-found result.** This matters because an
empty result is byte-identical to the truthful answer for an empty database, so a caller cannot
tell "the database is unreachable" from "there is nothing there":

- `tasks_*` reads (`list` / `get` / `status get`) raise `TaskBackendUnavailableError` naming the
  backend, the degraded state, and the underlying initialization error. Before mt#3636 they
  answered `{"tasks": [], "total": 0}` and "not found" with exit 0.
- `session_*` raises via the DI container's boot-deferral path.
- `memory_*` and `asks_*` raise, and (mt#3636) their messages now also carry the boot reason rather
  than a bare "not SQL-capable".

### The diagnostic plane stays available

Deliberately — "refuse to boot at all" would make the failure undiagnosable without a database:

```bash
minsky persistence check     # reports the underlying initialization failure
minsky debug systemInfo      # answers normally
minsky config list           # answers normally
```

### Two causes, opposite responses

Both raise; the messages are deliberately distinguishable, because the capability flags are
all-false in both cases and give the operator nothing to act on:

| State                                                      | Message says                                                            | Response                                                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Configured, init failed (`configuredButUnavailable: true`) | "Postgres IS configured, but initialization failed at boot: `<reason>`" | Fix connectivity, then **restart** — a failed provider is not currently re-initialized (mt#3635) |
| Not configured (`configuredButUnavailable: false`)         | "Persistence is not configured: `<reason>`"                             | Set `persistence.postgres.connectionString` or `MINSKY_PERSISTENCE_POSTGRES_URL`                 |

The distinction is rendered once by `describePersistenceUnavailability()` in
`packages/domain/src/persistence/unconfigured-provider.ts`. Per ADR-018 (quoted in ADR-027), the
unconfigured case is also an error rather than a silent fallback: _"A bare install with no Postgres
connection should fail with a clear 'configure Postgres' error, not silently fall back."_

A boot failure is logged at error level once at startup — but on **stderr**, which an MCP client
never sees. That is why each failing tool result carries the cause itself.

## Connection Pool Size

### Default

Each Minsky process opens a postgres-js connection pool whose **default maximum is derived, not
hardcoded** (`DEFAULT_POSTGRES_MAX_CONNECTIONS`). It currently evaluates to **8**.

Minsky runs as many concurrent processes — every Claude Code conversation runs its own MCP process,
plus the Railway-hosted MCP server, the reviewer service, and the cockpit menu-bar app — all sharing
one Supabase/Supavisor pooler. What that pooler rations is **client connections**, and the budget is
small:

| Input                             | Value | Where it comes from                                                                                                                                |
| --------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POOLER_CLIENT_BUDGET`            | 200   | Supabase's published compute table. `max_connections = 60` on this project pins the tier to Nano/Micro, and both carry a 200-client pooler ceiling |
| `POOL_BUDGET_FRACTION`            | 0.5   | the remainder is left for hosted services, ephemeral probes, and burst                                                                             |
| `ASSUMED_CONCURRENT_POOL_HOLDERS` | 12    | measured: 31 connections came from 8 distinct pids while 70-84 processes were alive — pools open lazily, so holders are far fewer than processes   |

`floor(200 × 0.5 / 12) = 8`, subject to a floor of 4 (`MIN_DERIVED_POOL_SIZE`) that preserves the
fan-out width the default exists to buy.

**History, because the previous version of this section was wrong in a way worth naming.** mt#1193
set the default to **3** to keep the fleet under the session-mode pooler's hard 15-slot ceiling.
After the 2026-04-24 migration to the **transaction-mode** pooler (`:6543`), this document (and the
code comment it mirrored) claimed that ceiling was "effectively gone (practical ceiling in the
thousands)", so the value "no longer rations a scarce global budget" and could be sized purely for
per-process fan-out. mt#2224 raised it to **15** on that basis.

That ceiling was never measured — it came from an agent-authored memory, not from the vendor. The
real ceiling for this project is **200 client connections**, at which **fourteen** processes running
a pool of 15 saturate the pooler. mt#2224's reasoning was correct for the fleet it measured; nothing
re-examined it when the fleet grew by an order of magnitude, because the assumption lived in prose
rather than in code. Deriving the value is what makes it re-checkable — if the tier, the fleet, or
the share changes, change the corresponding input and the default follows.

The per-process limit still sizes query **fan-out concurrency** (how many parallel queries one
process issues without client-side queueing); the derivation just bounds it by what the pooler can
actually serve. See mt#4308.

> **If you switch back to the session-mode pooler (`:5432`, 15-slot hard ceiling)** — only needed
> when session-scoped state like prepared statements, `LISTEN`, or advisory locks is required —
> lower this per-process limit so the fleet stays under 15 total. The retry policy below still
> applies in that case.

### Overriding the Pool Size

The pool size is resolved in priority order (highest wins):

1. **Config file** — `persistence.postgres.maxConnections` in `.minsky/config.yaml` or
   `~/.config/minsky/config.yaml`
2. **Environment variable** — `MINSKY_POSTGRES_MAX_CONNECTIONS`
3. **Built-in default** — derived, currently **8** (`DEFAULT_POSTGRES_MAX_CONNECTIONS`; see the
   derivation table above)

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

When Supavisor, PgBouncer, or Postgres itself rejects a new connection because the pool is full,
Minsky retries the operation automatically rather than failing immediately. Under the current
**transaction-mode** pooler (`:6543`) this rejection is unlikely (practical ceiling in the
thousands); the policy remains as defense-in-depth and is the primary guard when running against
the **session-mode** pooler (`:5432`, 15-slot ceiling).

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

1. Check how many Minsky MCP processes are running and their per-process pool size (default 15).
2. Check the Supabase/Supavisor pooler's global connection limit.
3. Consider reducing `maxConnections` per process or restarting idle MCP servers.

## In-process admission bound (mt#2773, extended mt#4473)

Separate from the retry policy above, which handles a pooler that REFUSES a connection. This bounds
what happens when the process's OWN pool is full.

`postgres` (postgres.js) has no checkout timeout — with all `max` connections busy, a new query is
either pipelined behind a running one or pushed onto an untimed queue, and in both cases it waits
without bound. That is the mechanism behind the 2026-08-23 incident, where eight concurrent
long-running MCP calls hung every subsequent DB-backed call for ~45 minutes with no error and no log
line. Minsky therefore admits queries above the driver, in
`packages/domain/src/persistence/raw-sql-pooler-guard.ts`.

**What is bounded.** In-flight queries are capped at the pool's own `max`, and callers beyond the
cap wait in an in-process FIFO for at most `POOL_ADMISSION_DEADLINE_MS` (30s) before being refused.
Since mt#4473 this covers **drizzle traffic as well as `.unsafe()`** — drizzle's postgres-js driver
issues every query through `client.unsafe()`, and the drizzle client is built over the same guarded
instance, so both share one counter. `sql.begin()` transactions still bypass it.

### Reading `debug_systemInfo.poolerSaturation`

| Field                           | Means                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `limit` / `inFlight` / `queued` | The cap, what is executing now, and who is parked waiting now.                                                                 |
| `peakInFlight` / `peakQueued`   | High-water marks for the process's lifetime — a burst is over by the time anyone looks.                                        |
| `everSaturated`                 | The cap was reached at least once. Ordinary under load; not a fault on its own.                                                |
| `refused` / `lastRefusedAt`     | **Read these first.** A caller waited the full admission deadline and got nothing. This is the outage shape, not a load level. |
| `guardCount`                    | Should be `1`. Above 1 means something re-wrapped the client and the other fields understate demand.                           |

Before mt#4473 these counters observed `.unsafe()` only, so a pool exhausted by drizzle traffic read
all zeros. A zero reading is now meaningful for both paths (still not for `sql.begin()`).

### `EPOOLADMISSIONTIMEOUT` / `PoolAdmissionTimeoutError`

**This is not a database outage.** It means this process's pool was full and stayed full for the
whole admission deadline — the queries holding it are long-running or wedged. The database is
typically healthy throughout; the discriminator is that a CLI DB read (which opens its own
connection) returns promptly while MCP calls hang.

```bash
minsky mcp status                # reports `db: degraded` for this condition
minsky mcp restart --execute     # clears it; the tray respawns the daemon
```

Refusal is deliberately preferred over an unbounded wait: a bounded failure naming its cause is
recoverable in seconds, and the unbounded one cost 45 minutes. A refusal under ORDINARY load would
be a regression, not expected behaviour — `refused` climbing during normal use means the pool is
undersized for real demand, which is a different question (mt#4360).

### Checking the bound on a live system

`scripts/verify-drizzle-pooler-bound.ts` exercises the real provider against whatever database is
configured: it fires `3 x max` concurrent drizzle SELECTs and asserts they are counted, capped, and
not refused. It is read-only, and it skips with exit 0 where no SQL-capable persistence is
configured — which is also why CI does not run it (CI has no live pool to saturate).

```bash
bun scripts/verify-drizzle-pooler-bound.ts
```

## Socket Inactivity Bound (mt#3592)

Every pooled connection carries a bound on how long its socket may sit with **no bytes moving in
either direction** before it is destroyed. Without it, a single half-open connection removes a pool
slot permanently, and after `maxConnections` of them the pool is dead: every DB-backed route hangs
indefinitely while the process itself stays healthy.

### The failure this prevents

A connection dropped at the network level without the client being notified leaves postgres-js's
query promise **never settled** — no error, no rejection, nothing to catch or retry
([porsager/postgres#1089](https://github.com/porsager/postgres/issues/1089)). `keep_alive` does not
detect this; #1089 says so explicitly, and it is the obvious-looking wrong fix. Observed on the
cockpit daemon three times on 2026-08-03 alone, each cleared only by a manual restart.

Destroying the socket converts "never settles" into a rejection: postgres-js errors the in-flight
query on close (`connection.js:453`), which releases the pool slot and gives the layers above a real
error to classify.

### How it is configured

The bound derives from `idleTimeout` (`idle_timeout` in postgres-js terms) rather than taking its
own config key, so the two cannot drift into contradicting each other. A healthy idle pooled
connection is inactive by definition, so any shorter bound would tear down healthy connections
earlier than the idle policy already does. A non-positive `idleTimeout` floors to **60 seconds** —
postgres-js reads `idle_timeout: 0` as "never idle out", and composing that with a disabled socket
bound would restore the unbounded hang.

### How inactivity is measured, and why not `socket.setTimeout`

By **sampling the socket's byte counters** on an interval — not with `socket.setTimeout`, whose
meaning is runtime-specific. Node refreshes that timer on socket activity; **Bun 1.2.21 does not.**
Measured 2026-08-03: a socket receiving data every 40 ms with `setTimeout(200, …)` armed fired its
timeout at 202 ms. Building on it would have severed every healthy pooled connection one
`idle_timeout` after it opened, mid-query. Detection therefore lands in
`[bound, bound + bound/4]`, with the sampling interval floored at 250 ms.

### Consequence worth knowing

At the socket layer a legitimately slow query is indistinguishable from a hung one — both sit with
no bytes moving — so **a query that runs longer than the bound will be severed.** At the 60 s
default this is far above anything this codebase issues on the pooled client, but migrations run on
this same client, so a long DDL statement is the case to watch. Raise `idleTimeout` if you need a
longer ceiling.

### Not covered

**TLS.** When the connection string enables `sslmode`, the bound is **not installed at all**, and a
`WARN` is logged saying so. postgres-js's `secure()` calls `socket.removeAllListeners()` before
wrapping the socket in `tls.connect()` (`connection.js:290`), and it is unverified whether the byte
counters this check samples still move once traffic runs through the wrapping TLS socket — a check
that read a busy connection as idle would sever it, which is worse than having no bound. Minsky does
not take this path today: no `ssl` option is passed and no `sslmode` appears in the connection
string, so `ssl` is postgres-js's `false` default. **mt#3603** owns bounding the TLS path.

**Multi-host failover.** Supplying a custom socket factory means postgres-js skips the branch that
rotates `hostIndex` across `options.host`, so the first host/port pair is used. Minsky points at a
single Supabase pooler host; this would matter only if a multi-host connection string were
introduced.

### Why the factory connects the socket itself

`connection.js`, in `connect()`:

```js
if (options.socket) return ssl ? secure() : connected();
```

Supplying a `socket` factory makes postgres-js **skip its own `socket.connect()` entirely** — it
assumes the returned socket is already connecting or connected. The first attempt at this fix
(mt#3092) returned an unconnected `new net.Socket()`; every write then failed with `Socket is
closed`, in every Minsky process that talks to Postgres, and it had to be reverted. The factory does
not await the connection — Node and Bun both buffer writes issued on a connecting socket — which
matches upstream #1089's own snippet.

`tests/integration/postgres-client-bounded-socket.integration.test.ts` opens a real connection
through `buildPostgresClient` for exactly this reason: no unit test that declines to connect can
catch that class of defect.

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
while the old one drains), the old container's open connections linger. Under the session-mode
pooler this counts against the global 15-slot ceiling and the new container hits pool saturation;
under the transaction pooler saturation is unlikely, but releasing sockets promptly is still good
hygiene (it avoids leaking idle connections during every redeploy).

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

## Migration Safety: Unmerged-Migration Guard (mt#2277)

`minsky persistence migrate --execute` will **refuse to apply a pending migration to a
shared production database if that migration's `.sql` file is not present on `origin/main`**.

This prevents the mt#2229 failure class: a feature-branch-only migration is applied to the
shared prod DB, the branch is then closed without merging, and the database and the repo
diverge (the applied migration has no record on `main`).

**How it classifies "production".** The guard runs only when the target connection is a
shared remote DB. Hosts treated as local/dev (guard skipped): `localhost`, `127.0.0.1`,
IPv6 loopback (`[::1]` / `::1`), `host.docker.internal`, and the Docker service aliases
`postgres` / `db` / `database`. Every other host (Supabase, Neon, RDS, any remote) is
treated as production. An unparseable connection string is treated as production
(fail-closed).

**What it checks.** For each pending migration (journal entries not yet in the ledger), the
guard verifies the `<tag>.sql` file resolves on `origin/main` (`git cat-file -e
origin/main:<path>`). If any pending migration is absent, the apply is blocked with the list
of offending migrations and the instruction to merge to `main` first.

**Fail-open on infra issues.** If `origin/main` does not resolve locally (no remote, a
differently-named remote, or simply not fetched), the guard **cannot** determine merge status,
so it does **not** block — it emits a warning and proceeds. Run `git fetch origin main` to
re-enable the check. This deliberately avoids false-blocking CI or fresh clones.

**Break-glass override.** Set `MINSKY_SKIP_UNMERGED_MIGRATION_CHECK=1` (or `true` / `yes`) to
bypass the guard when a migration is intentionally applied ahead of merge. The override is
audit-logged to stdout (env value + masked connection + timestamp):

```bash
MINSKY_SKIP_UNMERGED_MIGRATION_CHECK=1 minsky persistence migrate --execute
```

The override env-var name is registered in `HOOK_ONLY_ENV_VARS`
(`packages/domain/src/configuration/sources/environment.ts`, per mt#1788) and exported as the
constant `UNMERGED_MIGRATION_CHECK_OVERRIDE_ENV` so the guard, tests, and this doc cannot drift.

**Complement:** the immutable-migration _pre-commit_ guard (mt#2268) blocks _editing_ an
already-applied migration file; this guard blocks _applying_ an unmerged one. Together they
retire the mt#2229 / mt#2250 migration-drift class.

## Migration Folder Resolution (bundle-aware, mt#2369)

`minsky persistence migrate` resolves its Postgres migrations folder via
`resolvePgMigrationsFolder()` in
`packages/domain/src/persistence/postgres-migration-operations.ts`. The resolver tries
candidates in order and returns the first one whose `meta/_journal.json` exists:

| #   | Candidate                                         | When it wins                                                                                                                                                                 |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | `import.meta.dir/../storage/migrations/pg`        | Source-tree (dev): this file is at `packages/domain/src/persistence/`, one level up is `src/storage/migrations/pg`                                                           |
| b-1 | `import.meta.dir/storage/migrations/pg`           | Primary bundled-dist probe: `import.meta.dir` is the directory containing `dist/minsky.js`; migrations are copied there as `dist/storage/migrations/pg`                      |
| b-2 | `dirname(process.argv[1])/storage/migrations/pg`  | Secondary bundled-dist probe: `process.argv[1]` is the invoked script path (e.g. `/usr/local/bin/minsky.js`); useful when `import.meta.dir` differs from the binary location |
| c   | `<cwd>/packages/domain/src/storage/migrations/pg` | Legacy fallback: preserves pre-mt#2369 behaviour for `bun run src/cli.ts` from the repo root                                                                                 |

**Why `process.argv[1]`, not `process.argv[0]` or `process.execPath`.**
`process.argv[0]` and `process.execPath` both point to the Bun runtime binary (e.g.
`/home/user/.bun/bin/bun`), which is NOT co-located with the migration assets.
`process.argv[1]` is the path of the invoked script (`dist/minsky.js`), which IS
co-located with the bundled migrations at `dist/storage/migrations/pg`. Using
`process.argv[0]` / `process.execPath` would produce a wrong path like
`/home/user/.bun/bin/storage/migrations/pg` and fail to find the migrations.

**Diagnostic output.** If none of the candidates contains `meta/_journal.json`, the
command throws with the full list of tried paths so the operator can diagnose the issue.

**Cold-start regression gate.** The `.github/workflows/cold-start-migrate.yml` CI workflow
validates this resolver end-to-end on every PR: it builds the bundle, runs
`minsky persistence migrate --execute` from a temp directory outside the repo, then asserts
via `psql` that the `tasks` table was created AND that a follow-up dry-run reports 0 pending
migrations. A successful run conclusively proves the bundled binary resolves its migrations
from an arbitrary working directory.

### Pending-migration detection (per-migration hash, not row count)

Relocated from the top-level README (mt#3828).

`persistence migrate` (both `--dry-run` and `--execute`) reports which local migrations
are **pending** — not yet recorded as applied — by comparing each local `.sql` file's
sha256 hash against the full set of hashes recorded in `drizzle.__drizzle_migrations`,
NOT by subtracting row counts (`fileCount - appliedCount`). A raw count comparison
silently reports 0 pending whenever the DB's applied-row count meets or exceeds the local
file count for any reason unrelated to a specific migration's apply state — a historical
ledger squash/consolidation, a duplicate or orphaned ledger row, an out-of-band insert —
while a genuinely-unapplied migration goes unreported. The per-migration hash comparison
is robust to any such count offset: a migration is pending iff its file's hash is absent
from the ledger, full stop.

`getPostgresMigrationsStatus` exposes this as `pendingCount` (a number) and `pendingTags`
(the specific migration tags, e.g. `["0060_slow_kang"]`); the dry-run plan additionally
carries `plan.pendingFiles` (the same set, as filenames with `.sql`). A missing or
unreadable migration file (partial checkout, in-flight rename, permissions issue) is
never silently dropped — it is reported pending and logged as a warning, so the operator
sees the read failure rather than an unexplained gap in the count.

**The pending list is informational, not a guaranteed preview of what `migrate()` will
apply.** drizzle-orm's own `migrate()` does not decide what to run by hash-set
membership — it applies by a single-row **timestamp high-water-mark** (the latest
`created_at` already in the ledger vs. each journal entry's `when`). When the ledger has
an anomaly (a duplicate/orphaned row, an out-of-band insert, migrations recorded out of
`when`-order), the hash-missing set this tool reports and the set drizzle's own
high-water-mark check will actually apply can diverge — a migration this list names may
be silently skipped by drizzle (permanently shadowed), or the reverse. Every CLI listing
of pending migrations is labeled accordingly; treat it as "these files' hashes are not
recorded as applied," not as an exact forecast of `migrate()`'s next run.

## Cockpit daemon: unhandled-rejection dispositions (gh#1761, mt#4100)

When a DB-layer error reaches the cockpit daemon's `unhandledRejection` handler, the
daemon degrades gracefully or survives in place instead of crashing.

### The three dispositions (mt#4100)

`classifyUnhandledRejection(reason)` returns one of three, over **two distinct code
spaces** — conflating them is what mt#4100 was, so the docblock names which is which:

| Disposition | What reaches it                                                                                                                                                                                                                                                                                                     | Response                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `degrade`   | postgres-js **client-side** codes (`ECIRCUITBREAKER`, `EDBHANDLEREXITED`, `CONNECTION_CLOSED`, `CONNECTION_DESTROYED`), `PersistenceInitTimeoutError`, and **server-side** SQLSTATEs whose connection or server is unusable — class `08` (Connection Exception), `53` (Insufficient Resources), and `57P01`–`57P04` | steps 1–3 below                                                            |
| `survive`   | server-side SQLSTATEs where one STATEMENT failed on a healthy connection — `57014` query_canceled, `57P05` idle_session_timeout, and class `40` (Transaction Rollback)                                                                                                                                              | log via the rate-limited survived-error logger; **no state change at all** |
| `exit`      | anything else, including class `42` (Syntax Error or Access Rule Violation) — a malformed query is our bug                                                                                                                                                                                                          | `cleanupSync()` + `process.exit(1)`                                        |

Server-side codes are matched by SQLSTATE **class**, not by an enumerated list, so a
sibling code is covered without another incident. Class names are PostgreSQL's own
([Appendix A, Error Codes](https://www.postgresql.org/docs/current/errcodes-appendix.html)).
The assignment principle for a member named nowhere above: _is the connection unusable,
or did just this statement fail?_

### What happens on a `degrade`

1. `markDbDegraded()` resets the shared-persistence singleton so the next
   `getSharedPersistenceService()` call retries from scratch, and bumps the
   persistence epoch every cached consumer keys on (mt#3638).
2. `startDbRetryBackoff()` starts a background loop that retries
   `getSharedPersistenceService()` every 30 s (default;
   `DEFAULT_DB_RETRY_INTERVAL_MS`). On success the loop cancels its pending timer
   and stops — no further retries.
3. The `/api/health` endpoint returns `db: "degraded"` until the retry succeeds,
   at which point it returns `db: "ok"`.

A `survive` does **none** of that, deliberately: a cancelled statement leaves the pool
working, so tearing it down would invalidate every epoch-keyed cache and publish
`db: "degraded"` for a database that is fine.

The daemon **does not call `process.exit(1)`** for a condition at the database. Only
errors that are not classified as DB conditions (programming errors, unrelated library
bugs, etc.) still trigger the exit path.

### Why this matters

Before gh#1761 the handler called `process.exit(1)` for all unhandled rejections,
including DB circuit-breaker events. Combined with `KeepAlive` in the launchd plist,
this produced the 49,650-restart incident: the daemon crashed on every circuit-breaker
trip, launchd restarted it immediately (ThrottleInterval: 5), the new process
re-triggered the circuit breaker, and the loop continued until launchd's throttle
threshold was hit (~9 s later).

### Configuration

| Name                                         | Default   | Description                                                 |
| -------------------------------------------- | --------- | ----------------------------------------------------------- |
| `DEFAULT_DB_RETRY_INTERVAL_MS`               | 30,000 ms | Gap between DB reconnect attempts                           |
| `MINSKY_COCKPIT_PERSISTENCE_INIT_TIMEOUT_MS` | 30,000 ms | Deadline for each `PersistenceService.initialize()` attempt |

### Observability

- `WARN [shared-persistence] DB retry failed (...); next attempt in 30000ms` — each failed retry
- `INFO [shared-persistence] DB reconnected successfully via retry backoff` — on success
- `GET /api/health` returns `{ "db": "degraded" }` while retrying, `{ "db": "ok" }` after

### Related files

| File                                    | Role                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `src/cockpit/shared-persistence.ts`     | `startDbRetryBackoff`, `markDbDegraded`, `getDbStatus`, `PersistenceInitTimeoutError` |
| `src/commands/cockpit/start-command.ts` | `classifyUnhandledRejection`, `createUnhandledRejectionHandler`                       |
| `src/cockpit/server.ts`                 | `/api/health` endpoint (`db: getDbStatus()`)                                          |

## Boot-time init failure: re-initialization on use (mt#3635)

Applies to every process built on the DI container — the MCP server and the CLI.
(The cockpit daemon has its own singleton and its own recovery path, documented above and in
mt#3638; this section is not about that one.)

### What happens when initialization fails at boot

`createDomainContainer()`'s persistence factory is boot-tolerant: when a Postgres connection IS
configured but `initialize()` fails — an unreachable host, bad credentials, a migration error — it
returns `UnconfiguredPersistenceProvider` instead of throwing, so the process still starts and
`/health`, `config_*`, and `persistence_check` keep answering.

That substitute is now **enrolled for re-initialization**. On a later `container.get("persistence")`
the container re-runs the factory in the background; if it succeeds, the real provider replaces the
substitute AND every service registered after it is rebuilt, because services capture the provider
at their own construction time and would otherwise keep serving the degraded one. No process
restart or `/mcp` reconnect is required.

Before mt#3635 nothing retried: a transient failure at boot — the originating case was a ~20-second
DNS blip — left the process degraded for its entire lifetime. Per ADR-035, that is the class the
rule "a composition root must not register a substitute value for a failed initialization without
also registering the retry" exists to close.

### Retry schedule

| Property              | Value                                        |
| --------------------- | -------------------------------------------- |
| Trigger               | a `get()` of the affected key                |
| Minimum interval      | 10 s (`RETRY_MIN_INTERVAL_MS`)               |
| Backoff               | doubles per failed attempt, reset on success |
| Ceiling               | 5 min (`RETRY_MAX_INTERVAL_MS`)              |
| Concurrency           | at most one attempt in flight per key        |
| During `initialize()` | suppressed                                   |

Attempts are usage-gated, so there is no fixed attempt cap: a process that stops calling stops
retrying. The 10 s floor is what prevents a busy process from re-attempting once per call.

This is a **cross-call re-initialization** and is distinct from `withPgPoolRetry` (mt#1193, the
3-attempt / 150 ms / 2 s-cap schedule documented above), which is a **within-call** retry for pool
saturation on an already-initialized client. They compose: a re-init attempt runs a full
`PersistenceService.initialize()`, which uses `withPgPoolRetry` internally.

### Telling a stuck process from a live outage

Both `persistence_check` and the persistence block of `/health` report the last re-init attempt:

- **No attempt recorded** — nothing has been retried since boot. `persistence_check` says
  "No re-initialization has been attempted since boot"; `assessPersistenceHealth` omits
  `lastAttemptAt`.
- **An attempt recorded** — the provider is retrying and the database is still unreachable.
  Both surfaces name the attempt timestamp and its error, and `persistence_check` says explicitly
  that no restart is needed.

The distinction is the point: the first state calls for a restart, the second for fixing the
database, and before mt#3635 the two produced identical output.

### Verifying it

`bun scripts/verify-persistence-self-heal.ts` drives the whole arc against a real Postgres —
initialization failing with `getaddrinfo ENOTFOUND`, then recovering on a later use with no
restart, the dependent service rebuilt, and the rate limit holding. It skips with exit 0 when no
database is reachable; point it at one with `INTEGRATION_POSTGRES_URL`.

### Related files

| File                                                       | Role                                                |
| ---------------------------------------------------------- | --------------------------------------------------- |
| `packages/domain/src/composition/container.ts`             | enrollment, backoff, dependent rebuild              |
| `packages/domain/src/composition/domain.ts`                | the persistence factory that returns the substitute |
| `packages/domain/src/persistence/unconfigured-provider.ts` | `DegradedSubstitute` marker + attempt bookkeeping   |
| `packages/domain/src/persistence/health.ts`                | `lastAttemptAt` on the liveness surface             |
| `packages/domain/src/persistence/validation-operations.ts` | `persistence_check`'s retry-state report            |

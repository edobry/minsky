/**
 * Postgres Pool Saturation Integration Tests — Testcontainers + Raw Postgres
 *
 * Exercises Minsky's withPgPoolRetry / isPgPoolExhaustionError end-to-end
 * against a Testcontainers-managed Postgres with `max_connections = 10`.
 *
 * This is the **durable contract test** for the pool-saturation retry path:
 * raw Postgres SQLSTATE 53300 ("too_many_connections") is a stable Postgres
 * protocol error that won't change regardless of which managed Postgres host
 * Minsky uses. Complements the vendor-specific Supabase/Supavisor harness in
 * `postgres-pool-saturation.supabase.integration.test.ts` (mt#1364), which
 * exercises the XX000 "max clients reached" shape that's specific to the
 * Supavisor pooler currently fronting our production Postgres.
 *
 * Coverage produced by this file (in combination with mt#1364):
 *
 *   - Raw Postgres `53300`            → THIS file (durable)
 *   - Supavisor `XX000 max clients`   → mt#1364 (vendor-specific to Supabase)
 *   - PgBouncer "sorry, too many"     → unit tests only (not in our prod path)
 *
 * Tasks: mt#1205 (umbrella), mt#1365 (this file)
 *
 * Gate: TWO env vars required, both must be set:
 *   RUN_INTEGRATION_TESTS=1
 *   RUN_TESTCONTAINER_TESTS=1
 *
 * The two-level gate exists because container-based tests have stricter
 * preconditions than other integration tests (need Docker daemon; need
 * minutes for cold first-pull; need the longer 180s timeout the
 * `test:integration:docker` script provides). Sitting behind a second
 * sentinel keeps `test:integration` from inheriting these constraints.
 *
 * If both env vars are unset, the file produces zero tests and zero
 * failures (matches the contract used by mt#1364's wrapper).
 *
 * If both env vars are set but Docker is unreachable, container start
 * throws loudly with a clear error rather than silently passing —
 * silent passes on missing infra are a false-negative class we
 * explicitly avoid (per the BLOCKING reviewer finding on mt#1364
 * PR #843 round 2).
 *
 * Run:
 *   bun run test:integration:docker
 *
 * Or manually:
 *   RUN_INTEGRATION_TESTS=1 RUN_TESTCONTAINER_TESTS=1 \
 *     bun test --preload ./tests/setup.ts --timeout=180000 \
 *       tests/integration/postgres-pool-saturation.testcontainer.integration.test.ts
 *
 * See `docs/persistence-configuration.md` § "Local Raw-Postgres Saturation
 * Harness" for the bring-up rationale and the asymmetric-coverage framing.
 */

import { afterAll, describe } from "bun:test";
import { GenericContainer, type WaitStrategy } from "testcontainers";
import postgres from "postgres";
import { runSaturationSuite } from "./postgres-pool-saturation.shared";

// No-op wait strategy: resolves immediately when testcontainers reports the
// container as started. We bypass all testcontainers readiness machinery and
// do our own SQL-level probe after start() returns. This is necessary because
// every built-in wait strategy (forListeningPorts, the default log-based
// strategy, etc.) hangs indefinitely under Bun due to Bun-specific
// incompatibilities in testcontainers' docker socket / child_process polling.
const noOpWaitStrategy: WaitStrategy = {
  async waitUntilReady() {
    // Intentionally empty — readiness is determined by the SQL probe below.
  },
  withStartupTimeout() {
    return this;
  },
  isStartupTimeoutSet() {
    return false;
  },
  getStartupTimeout() {
    return 120_000;
  },
};

// Server-side max_connections. We bump above the strict minimum so that
// Postgres background workers (autovacuum) and superuser_reserved_connections
// don't squeeze the effective ceiling below what the test expects.
const MAX_CONNECTIONS = 10;

// poolSize the shared helper sees. It will hold POOL_SIZE long-lived clients
// to consume the ceiling, then race POOL_SIZE+5 more that must retry —
// saturation guaranteed even with a few connections held by background work.
const POOL_SIZE = 8;

// Image with pgvector pre-installed so the AT-4 vector-storage path can run.
const POSTGRES_IMAGE = "pgvector/pgvector:pg16";

// Two-level gate — see the file header for the rationale.
//
// Note: we do NOT use `describe.if(...)` here because runSaturationSuite
// creates its own `describe` block internally; nesting `describe.if` would
// produce awkward double-wrapping.
if (process.env.RUN_INTEGRATION_TESTS && process.env.RUN_TESTCONTAINER_TESTS) {
  // Top-level await: start the container BEFORE registering tests so the
  // connection string is real by the time runSaturationSuite destructures
  // it. Container startup happens outside Bun's per-test timeout — the
  // Testcontainers `withStartupTimeout(120_000)` is the only protection
  // here. The `test:integration:docker` script uses --timeout=180000 to
  // give bun:test enough headroom for the test bodies after startup.
  process.stdout.write(
    `[saturation/testcontainer] starting ${POSTGRES_IMAGE} with max_connections=${MAX_CONNECTIONS}\n`
  );

  let container;
  try {
    container = await new GenericContainer(POSTGRES_IMAGE)
      .withEnvironment({
        POSTGRES_PASSWORD: "postgres",
        POSTGRES_USER: "postgres",
        POSTGRES_DB: "postgres",
      })
      // -c max_connections=N caps the server-side connection ceiling.
      .withCommand(["postgres", "-c", `max_connections=${MAX_CONNECTIONS}`])
      .withExposedPorts(5432)
      // noOpWaitStrategy replaces the default Wait.forListeningPorts() which
      // hangs indefinitely under Bun. Every built-in testcontainers wait
      // strategy (port-listen, log-scan) uses docker socket polling that has
      // a Bun-specific incompatibility. The no-op resolves immediately so
      // start() returns as soon as the container process is up; our SQL probe
      // loop below then takes over as the actual readiness gate.
      .withWaitStrategy(noOpWaitStrategy)
      .withStartupTimeout(120_000)
      .start();
  } catch (err) {
    process.stdout.write(
      `[saturation/testcontainer] container start FAILED: ${err instanceof Error ? err.message : String(err)}\n`
    );
    throw err;
  }

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const probeUrl = `postgresql://postgres:postgres@${host}:${port}/postgres`;

  // Manual SQL-level readiness probe: poll until Postgres accepts a SELECT 1
  // or the 60s deadline expires. This replaces Wait.forListeningPorts() which
  // hangs under Bun. The probe is the canonical postgres readiness check and
  // gives us the same guarantee (SQL-level proof that the server is accepting
  // connections), not just a TCP-level listen check.
  process.stdout.write(
    `[saturation/testcontainer] container started, probing SQL readiness at ${host}:${port}\n`
  );
  // eslint-disable-next-line custom/no-real-fs-in-tests -- Date.now() is used for a timing deadline, not path creation; the rule's BinaryExpression check produces a false positive here
  const probeDeadline = Date.now() + 60_000;
  let probeReady = false;
  // eslint-disable-next-line custom/no-real-fs-in-tests -- same false positive: Date.now() compared against a deadline variable, not used in path construction
  while (Date.now() < probeDeadline) {
    try {
      const probe = postgres(probeUrl, { max: 1, prepare: false, connect_timeout: 2 });
      try {
        await probe`SELECT 1`;
        probeReady = true;
        break;
      } finally {
        await probe.end().catch(() => {});
      }
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!probeReady) {
    await container.stop().catch(() => {});
    throw new Error(
      `[saturation/testcontainer] postgres readiness probe timed out after 60s at ${host}:${port}`
    );
  }

  const connectionString = probeUrl;

  process.stdout.write(`[saturation/testcontainer] container ready at ${host}:${port}\n`);

  // Wrap the shared suite so afterAll teardown is colocated with the
  // container's lifecycle. The shared helper creates its own inner
  // `describe`, which nests cleanly inside this one.
  //
  // Resource-leak guard: if `describe` registration itself throws (extremely
  // rare, but possible if a transitive import fails inside the suite body),
  // do a best-effort stop synchronously so the container isn't orphaned on
  // Ryuk-disabled CI.
  try {
    describe("Postgres pool saturation [testcontainer wrapper]", () => {
      afterAll(async () => {
        process.stdout.write(`[saturation/testcontainer] stopping container\n`);
        await container.stop();
      });

      runSaturationSuite({
        connectionString,
        poolSize: POOL_SIZE,
        label: "testcontainer-raw-pg",
      });
    });
  } catch (err) {
    process.stdout.write(
      `[saturation/testcontainer] suite registration failed; stopping container: ${err instanceof Error ? err.message : String(err)}\n`
    );
    await container.stop().catch(() => {});
    throw err;
  }
} else {
  const missing: string[] = [];
  if (!process.env.RUN_INTEGRATION_TESTS) missing.push("RUN_INTEGRATION_TESTS=1");
  if (!process.env.RUN_TESTCONTAINER_TESTS) missing.push("RUN_TESTCONTAINER_TESTS=1");
  process.stdout.write(
    `[saturation/testcontainer] integration tests skipped — set ${missing.join(", ")} (or run \`bun run test:integration:docker\`) to run\n`
  );
}

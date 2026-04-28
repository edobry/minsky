/**
 * Postgres Pool Saturation Integration Tests — Testcontainers + Raw Postgres
 *
 * Exercises Minsky's withPgPoolRetry / isPgPoolExhaustionError end-to-end
 * against a Testcontainers-managed Postgres with `max_connections = 5`.
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
 * Gate: runs ONLY when `RUN_INTEGRATION_TESTS=1` is set AND the docker daemon
 * is reachable. If RUN_INTEGRATION_TESTS is unset, the file produces zero
 * tests and zero failures (matches the contract used by mt#1364's wrapper).
 * If docker is unreachable, container start throws loudly with a clear error
 * — that is the correct semantic, not a silent skip.
 *
 * Run:
 *   RUN_INTEGRATION_TESTS=1 \
 *     bun test --preload ./tests/setup.ts --timeout=120000 \
 *       tests/integration/postgres-pool-saturation.testcontainer.integration.test.ts
 *
 * See `docs/persistence-configuration.md` § "Local Raw-Postgres Saturation
 * Harness" for the bring-up rationale and the asymmetric-coverage framing.
 */

import { afterAll, describe } from "bun:test";
import { GenericContainer, Wait } from "testcontainers";
import { runSaturationSuite } from "./postgres-pool-saturation.shared";

// pool_size for the Postgres server. The shared helper opens POOL_SIZE
// long-lived clients to consume the ceiling, then races POOL_SIZE+5
// more that must retry — saturation is guaranteed.
const POOL_SIZE = 5;

// Image with pgvector pre-installed so the AT-4 vector-storage path can run.
const POSTGRES_IMAGE = "pgvector/pgvector:pg16";

// Top-level skip-gate. Mirrors the convention used by the Supabase wrapper:
// produce zero tests / zero failures when RUN_INTEGRATION_TESTS is absent,
// so this file is safe to include in a broad `bun test` run.
//
// Note: we do NOT use `describe.if(...)` here because runSaturationSuite
// creates its own `describe` block internally; nesting `describe.if` would
// produce awkward double-wrapping. See the matching note in the Supabase
// wrapper for the rationale.
if (process.env.RUN_INTEGRATION_TESTS) {
  // Top-level await: start the container BEFORE registering tests so the
  // connection string is real by the time runSaturationSuite destructures
  // it. If docker is unreachable, this throws and the suite fails loudly —
  // intended, since silent passes on missing infra are a false-negative
  // class we explicitly avoid (see mt#1364 PR #843 round 2 review).
  process.stdout.write(
    `[saturation/testcontainer] starting ${POSTGRES_IMAGE} with max_connections=${POOL_SIZE}\n`
  );

  const container = await new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_USER: "postgres",
      POSTGRES_DB: "postgres",
    })
    // -c max_connections=N caps the server-side connection ceiling.
    .withCommand(["postgres", "-c", `max_connections=${POOL_SIZE}`])
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const connectionString = `postgresql://postgres:postgres@${host}:${port}/postgres`;

  process.stdout.write(`[saturation/testcontainer] container ready at ${host}:${port}\n`);

  // Wrap the shared suite so afterAll teardown is colocated with the
  // container's lifecycle. The shared helper creates its own inner
  // `describe`, which nests cleanly inside this one.
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
} else {
  process.stdout.write(
    `[saturation/testcontainer] integration tests skipped — set RUN_INTEGRATION_TESTS=1 to run\n`
  );
}

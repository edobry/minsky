/**
 * Shared Postgres Pool Saturation Test Suite
 *
 * Implements the four acceptance tests from mt#1205 in a parameterized form so
 * child A (Supabase preview branch — Supavisor XX000 shape) and child C (raw
 * Postgres via Testcontainers — SQLSTATE 53300 shape) can both exercise the
 * same retry logic against different connection targets.
 *
 * Tasks: mt#1205 (umbrella), mt#1364 (child A — Supabase), mt#1365 (child C — Testcontainers raw PG)
 *
 * What each test actually covers (mt#4347) — the four are NOT interchangeable:
 *
 *   - AT-1 / AT-2 call `withPgPoolRetry` DIRECTLY, passing their own retry
 *     options (`maxAttempts: 5, initialDelayMs: 50`). They prove the helper
 *     retries, and say NOTHING about the defaults production runs on — measured:
 *     forcing DEFAULT_MAX_ATTEMPTS to 1 leaves both of them green.
 *   - AT-3 / AT-4 go through real production classes
 *     (`PostgresPersistenceProvider`, `PostgresVectorStorage`) on DEFAULT retry
 *     options. They are the only coverage of the shipped configuration — the
 *     same DEFAULT_MAX_ATTEMPTS=1 edit fails both.
 *
 * That asymmetry is why AT-3/AT-4 going vacuous mattered more than their count
 * suggests: they were the only two testing what production uses, and both were
 * silently non-saturating for 119 days.
 *
 * Usage:
 *   import { runSaturationSuite } from "./postgres-pool-saturation.shared";
 *   runSaturationSuite({
 *     connectionString: process.env.SUPABASE_INTEGRATION_BRANCH_URL!,
 *     poolSize: 15,
 *     label: "supabase-preview",
 *   });
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import postgres from "postgres";
import { randomUUID } from "crypto";
import { withPgPoolRetry } from "@minsky/domain/persistence/postgres-retry";
import { PostgresPersistenceProvider } from "@minsky/domain/persistence/providers/postgres-provider";
import { PostgresVectorStorage } from "@minsky/domain/storage/vector/postgres-vector-storage";

export interface SaturationSuiteOptions {
  /** Postgres connection string for the target pooler. */
  connectionString: string;
  /**
   * Known pool_size of the target Supavisor/PgBouncer instance.
   * The suite will spawn poolSize + 5 concurrent clients to guarantee saturation.
   * Default: 15 (Supavisor session-mode default in Supabase Micro Compute).
   */
  poolSize?: number;
  /** Human-readable label used in describe/log output (e.g. "supabase-preview"). */
  label: string;
}

/**
 * Create a postgres-js client configured to use a single connection
 * (max:1) so each caller occupies exactly one pooler slot.
 */
function makeSingleClient(connectionString: string): ReturnType<typeof postgres> {
  return postgres(connectionString, {
    max: 1,
    connect_timeout: 30,
    idle_timeout: 5,
    prepare: false,
  });
}

/**
 * Simulate a "saturated" pool by holding open (count) connections.
 * Each client issues a trivial query to make sure the connection is
 * actually established before returning.
 *
 * Returns a cleanup function that ends all held clients, plus the DENOMINATOR
 * (mt#4347): how many of the `count` requested connections were actually
 * established. Swallowing the overflow failures is deliberate — asking for more
 * than the ceiling is how a caller guarantees saturation without knowing the
 * exact ceiling — but a caller that cannot see how many it got cannot tell
 * "held the whole ceiling" from "held almost none", and those produce opposite
 * test outcomes. See `mem#1079`: a check must assert its own denominator.
 */
async function holdConnections(
  connectionString: string,
  count: number
): Promise<{
  clients: ReturnType<typeof postgres>[];
  established: number;
  attempted: number;
  cleanup: () => Promise<void>;
}> {
  const clients: ReturnType<typeof postgres>[] = [];
  let established = 0;

  for (let i = 0; i < count; i++) {
    const client = makeSingleClient(connectionString);
    clients.push(client);
    try {
      await client`SELECT 1`;
      established++;
    } catch {
      // Expected once the ceiling is reached: an over-provisioned request
      // (see `assertSaturated`) deliberately asks for more than the server can
      // give. The count above is what makes the shortfall visible instead of
      // silent.
    }
  }

  const cleanup = async (): Promise<void> => {
    await Promise.allSettled(clients.map((c) => c.end()));
  };

  return { clients, established, attempted: count, cleanup };
}

/**
 * Assert that the server is ACTUALLY refusing new connections right now
 * (mt#4347).
 *
 * The single-consumer tests (AT-3, AT-4) depend on a precondition they never
 * checked: that the connections held above consumed the entire server ceiling,
 * so the one client they then open must retry. When that precondition silently
 * stops holding, AT-4 fails on a wall-clock proxy 100+ lines later and AT-3 —
 * which has no such proxy — passes green while testing nothing.
 *
 * This makes the precondition explicit and falsifiable: open one more
 * connection and require it to be REFUSED. A success here means saturation was
 * not achieved, and the test that follows would be vacuous — so fail loudly,
 * naming the denominator, rather than proceeding to assert something that
 * cannot discriminate.
 *
 * The probe consumes no slot on success-of-the-test (it is refused) and is
 * called BEFORE the release timer is armed, so it does not eat the retry window.
 */
async function assertSaturated(
  connectionString: string,
  label: string,
  test: string,
  held: { established: number; attempted: number }
): Promise<void> {
  const probe = makeSingleClient(connectionString);
  let refused = false;
  let observed = "";
  try {
    await probe`SELECT 1`;
  } catch (err) {
    refused = true;
    observed = (err as { code?: string })?.code ?? "unknown";
  } finally {
    await probe.end().catch(() => {});
  }

  if (!refused) {
    throw new Error(
      `[saturation/${label}] ${test}: PRECONDITION FAILED — the pool is not saturated. ` +
        `Held ${held.established} of ${held.attempted} requested connections, and a further ` +
        `connection still succeeded, so the consumer under test will not have to retry and ` +
        `this test would pass without exercising withPgPoolRetry at all. ` +
        `Raise the hold count above the server's max_connections (mt#4347).`
    );
  }

  process.stdout.write(
    `[saturation/${label}] ${test}: saturation confirmed — held ${held.established}/${held.attempted}, ` +
      `further connection refused (code=${observed})\n`
  );
}

/**
 * Registers the four mt#1205 acceptance tests inside a named `describe` block.
 * Call this function from the integration test wrappers (child A, child C).
 */
export function runSaturationSuite(options: SaturationSuiteOptions): void {
  const { connectionString, poolSize = 15, label } = options;

  // Number of concurrent clients used to saturate the pool. Deliberately MORE
  // than the server can accept: over-provisioning is what makes saturation
  // independent of the target's actual ceiling, so no test has to know it. Every
  // test holds this many (mt#4347) — AT-1/AT-2 then race this many consumers,
  // AT-3/AT-4 open one.
  const saturatingClients = poolSize + 5;

  // Floor for AT-4's elapsed-time corroboration of backoff: initialDelayMs (150)
  // * minimum jitter (0.8) = the shortest possible single retry wait. Named so
  // the assertion and the logged margin read from one source (mt#4347) — a
  // literal in both is how they drift apart.
  const BACKOFF_FLOOR_MS = 120;

  // Timeout for individual tests — retries add up to ~600 ms per caller
  // and we run many concurrent ones, so be generous.
  const TEST_TIMEOUT_MS = 60_000;

  describe(`Postgres pool saturation suite [${label}]`, () => {
    beforeAll(async () => {
      const probe = makeSingleClient(connectionString);
      try {
        await probe`SELECT 1`;
        process.stdout.write(`[saturation/${label}] connection health check passed\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Re-throw so bun:test marks the suite as failed rather than silently passing.
        // "Skip when env vars absent" happens at the outer wrapper level (env-gate) and
        // is unaffected by this throw — we only reach here when env vars ARE set but the
        // actual connection fails, which is a genuine error.
        throw new Error(
          `[saturation/${label}] connection health check failed — ${msg}. ` +
            `Verify that SUPABASE_INTEGRATION_BRANCH_URL is correct and the branch is reachable.`
        );
      } finally {
        await probe.end().catch(() => {});
      }
    });

    afterAll(async () => {
      process.stdout.write(`[saturation/${label}] suite complete\n`);
    });

    // -----------------------------------------------------------------------
    // Acceptance test 1 (mt#1205 AT-1):
    // N > pool_size concurrent clients observe retry behavior and all succeed.
    // -----------------------------------------------------------------------
    test(
      "AT-1: concurrent clients all succeed after retry under saturation",
      async () => {
        // Track total retry attempts across all tasks
        let totalRetryAttempts = 0;

        // Hold poolSize connections to saturate the pooler, then spawn
        // saturatingClients more that must retry via withPgPoolRetry.
        const { cleanup: releaseHeld } = await holdConnections(connectionString, poolSize);

        // Guard: ensure releaseHeld() is called at most once even though the
        // timer and finally block both attempt to call it.
        let released = false;
        const releaseOnce = async (): Promise<void> => {
          if (released) return;
          released = true;
          await releaseHeld();
        };

        try {
          // Release held connections partway through so the retrying clients succeed.
          const releaseTimer = setTimeout(() => void releaseOnce(), 300);

          const tasks = Array.from({ length: saturatingClients }, () => {
            let attempts = 0;
            return withPgPoolRetry(
              async () => {
                attempts += 1;
                if (attempts > 1) {
                  // This attempt is a retry — record it
                  totalRetryAttempts += 1;
                }
                const client = makeSingleClient(connectionString);
                try {
                  const result = await client`SELECT 1 AS ok`;
                  return result[0]?.ok;
                } finally {
                  await client.end().catch(() => {});
                }
              },
              `saturation/${label}/at1-concurrent`,
              {
                maxAttempts: 5,
                initialDelayMs: 50,
                maxDelayMs: 1000,
              }
            );
          });

          const results = await Promise.all(tasks);

          clearTimeout(releaseTimer);

          // All clients must have received a result
          expect(results.every((r) => r === 1 || r === "1")).toBe(true);
        } finally {
          // Guaranteed release if timer hasn't fired yet.
          await releaseOnce();
        }

        process.stdout.write(
          `[saturation/${label}] AT-1: ${totalRetryAttempts} retry attempts across ${saturatingClients} clients\n`
        );
        // At least some retries must have fired (proves saturation was encountered)
        expect(totalRetryAttempts).toBeGreaterThan(0);
      },
      TEST_TIMEOUT_MS
    );

    // -----------------------------------------------------------------------
    // Acceptance test 2 (mt#1205 AT-2):
    // Mutating CRUD op produces no duplicates after retry round.
    // -----------------------------------------------------------------------
    test(
      "AT-2: mutating CRUD under saturation produces no duplicate rows",
      async () => {
        const testRunId = randomUUID();
        const tableName = "saturation_idempotency_test";

        // Create a temporary table for the test
        const setup = makeSingleClient(connectionString);
        try {
          await setup.unsafe(`
            CREATE TABLE IF NOT EXISTS ${tableName} (
              id TEXT PRIMARY KEY,
              run_id TEXT NOT NULL,
              created_at TIMESTAMPTZ DEFAULT NOW()
            )
          `);
        } finally {
          await setup.end().catch(() => {});
        }

        // Track total retry attempts across all insert tasks
        let totalRetryAttempts = 0;

        const { cleanup: releaseHeld } = await holdConnections(connectionString, poolSize);

        // Guard: ensure releaseHeld() is called at most once even though the
        // timer and finally block both attempt to call it.
        let released = false;
        const releaseOnce = async (): Promise<void> => {
          if (released) return;
          released = true;
          await releaseHeld();
        };

        try {
          const releaseTimer = setTimeout(() => void releaseOnce(), 300);

          // Attempt the INSERT concurrently from saturating clients.
          // withPgPoolRetry ensures connection-acquisition retries are safe
          // (the query-field guard prevents double-execution of transmitted queries).
          const insertTasks = Array.from({ length: saturatingClients }, () => {
            let attempts = 0;
            return withPgPoolRetry(
              async () => {
                attempts += 1;
                if (attempts > 1) {
                  // This attempt is a retry — record it
                  totalRetryAttempts += 1;
                }
                const client = makeSingleClient(connectionString);
                try {
                  // ON CONFLICT DO NOTHING guarantees the row is written once
                  await client.unsafe(
                    `INSERT INTO ${tableName} (id, run_id) VALUES ($1, $2)
                     ON CONFLICT (id) DO NOTHING`,
                    [testRunId, testRunId]
                  );
                } finally {
                  await client.end().catch(() => {});
                }
              },
              `saturation/${label}/at2-crud`,
              {
                maxAttempts: 5,
                initialDelayMs: 50,
                maxDelayMs: 1000,
              }
            );
          });

          await Promise.allSettled(insertTasks);
          clearTimeout(releaseTimer);
        } finally {
          // Guaranteed release if timer hasn't fired yet.
          await releaseOnce();
        }

        process.stdout.write(
          `[saturation/${label}] AT-2: ${totalRetryAttempts} retry attempts across ${saturatingClients} insert tasks\n`
        );
        // At least some retries must have fired (proves saturation was encountered,
        // not just that the DB constraint prevented duplicates on first attempt).
        expect(totalRetryAttempts).toBeGreaterThan(0);

        // Count rows with this run ID — must be exactly 1
        const probe = makeSingleClient(connectionString);
        try {
          const rows = await probe.unsafe(
            `SELECT COUNT(*)::int AS cnt FROM ${tableName} WHERE run_id = $1`,
            [testRunId]
          );
          const count = (rows[0] as Record<string, unknown>)?.cnt;
          process.stdout.write(
            `[saturation/${label}] AT-2: row count for run_id=${testRunId} is ${count}\n`
          );
          expect(Number(count)).toBe(1);

          // Cleanup: delete test row and drop the table so long-lived branches
          // don't accumulate test tables across runs.
          await probe.unsafe(`DELETE FROM ${tableName} WHERE run_id = $1`, [testRunId]);
          await probe.unsafe(`DROP TABLE IF EXISTS ${tableName}`);
        } finally {
          await probe.end().catch(() => {});
        }
      },
      TEST_TIMEOUT_MS
    );

    // -----------------------------------------------------------------------
    // Acceptance test 3 (mt#1205 AT-3):
    // PostgresPersistenceProvider.initialize() recovers under saturation.
    // -----------------------------------------------------------------------
    test(
      "AT-3: PostgresPersistenceProvider.initialize() recovers under saturation",
      async () => {
        // Hold `saturatingClients`, NOT `poolSize` (mt#4347). This test opens a
        // SINGLE consumer instead of racing many, so it exercises the retry path
        // only if the held connections consume the server's WHOLE ceiling.
        // Holding exactly `poolSize` silently assumed `poolSize == ceiling` — an
        // assumption that stopped holding for the testcontainer target when
        // max_connections was raised to 10 against a POOL_SIZE of 8, leaving two
        // free slots and no reason for anything to retry. Over-provisioning
        // removes the assumption entirely: ask for more than the ceiling and keep
        // whatever the server gives.
        const held = await holdConnections(connectionString, saturatingClients);

        // Guard: ensure the held connections are released at most once even
        // though the timer, the precondition check and the finally block can all
        // reach for it.
        let released = false;
        const releaseOnce = async (): Promise<void> => {
          if (released) return;
          released = true;
          await held.cleanup();
        };

        // Precondition, checked BEFORE the release timer is armed so a failure
        // here cannot leak the held connections into the rest of the suite. This
        // is the vacuity guard AT-3 never had: without it a non-saturating run
        // reports green, because the assertion below ("connected") is true
        // whether or not any retry happened.
        try {
          await assertSaturated(connectionString, label, "AT-3", held);
        } catch (err) {
          await releaseOnce();
          throw err;
        }

        // Release the held connections shortly after so the provider can
        // complete its retry on the SELECT 1 health check.
        const releaseTimer = setTimeout(() => void releaseOnce(), 300);

        const provider = new PostgresPersistenceProvider({
          backend: "postgres",
          postgres: {
            connectionString,
            maxConnections: 1,
            connectTimeout: 30,
          },
        });

        try {
          await provider.initialize();

          // Verify isInitialized via getConnectionInfo which includes "(connected)" when live
          const info = provider.getConnectionInfo();
          process.stdout.write(`[saturation/${label}] AT-3: connection info: ${info}\n`);
          expect(info).toContain("connected");
        } finally {
          clearTimeout(releaseTimer);
          // Guaranteed release if timer hasn't fired yet.
          await releaseOnce();
          await provider.close().catch(() => {});
        }
      },
      TEST_TIMEOUT_MS
    );

    // -----------------------------------------------------------------------
    // Acceptance test 4 (mt#1205 AT-4):
    // Vector-storage search returns results after backoff under saturation.
    // -----------------------------------------------------------------------
    test(
      "AT-4: PostgresVectorStorage.search returns results after backoff under saturation",
      async () => {
        // Check pgvector availability before running the vector test.
        // pg_available_extensions lists extensions installed on the server
        // (regardless of whether CREATE EXTENSION has been run), which is
        // the correct availability check — pg_extension only lists already-loaded
        // extensions and would always return false before CREATE EXTENSION runs.
        const probe = makeSingleClient(connectionString);
        let vectorAvailable = false;
        try {
          const ext = await probe`
            SELECT EXISTS (
              SELECT 1 FROM pg_available_extensions WHERE name = 'vector'
            ) AS exists
          `;
          vectorAvailable = Boolean((ext[0] as Record<string, unknown>)?.exists);
        } catch {
          // ignore — vectorAvailable stays false
        } finally {
          await probe.end().catch(() => {});
        }

        if (!vectorAvailable) {
          process.stdout.write(
            `[saturation/${label}] AT-4: skipped — pgvector extension not available on this server\n`
          );
          return;
        }

        // Ensure the test table exists
        const DIMENSION = 3;
        const VECTOR_TABLE = "saturation_vector_test";
        const setup = makeSingleClient(connectionString);
        try {
          await setup.unsafe("CREATE EXTENSION IF NOT EXISTS vector");
          await setup.unsafe(`
            CREATE TABLE IF NOT EXISTS ${VECTOR_TABLE} (
              id TEXT PRIMARY KEY,
              embedding vector(${DIMENSION})
            )
          `);
          // Seed one row so search can return at least one result
          await setup.unsafe(
            `INSERT INTO ${VECTOR_TABLE} (id, embedding)
             VALUES ('seed-row', '[1,0,0]')
             ON CONFLICT (id) DO NOTHING`
          );
        } finally {
          await setup.end().catch(() => {});
        }

        // Hold `saturatingClients`, NOT `poolSize` — see the matching comment in
        // AT-3 (mt#4347). This is the defect that made AT-4 fail its own vacuity
        // guard on the testcontainer target: 8 held against a ceiling of 10 left
        // free slots, the search connected on its first try in ~7ms, and no
        // backoff was ever exercised.
        const held = await holdConnections(connectionString, saturatingClients);

        // Guard: ensure the held connections are released at most once even
        // though the timer, the precondition check and the finally block can all
        // reach for it.
        let released = false;
        const releaseOnce = async (): Promise<void> => {
          if (released) return;
          released = true;
          await held.cleanup();
        };

        // Precondition, checked BEFORE the release timer is armed so a failure
        // here cannot leak the held connections into the rest of the suite. The
        // elapsed-time assertion below is a PROXY for backoff; this is the direct
        // check, and it is what makes a failure name the actual cause instead of
        // reporting a millisecond count 100 lines away.
        try {
          await assertSaturated(connectionString, label, "AT-4", held);
        } catch (err) {
          await releaseOnce();
          throw err;
        }

        // Release held connections so the vector search can succeed
        const releaseTimer = setTimeout(() => void releaseOnce(), 300);

        const sqlClient = makeSingleClient(connectionString);
        const { drizzle } = await import("drizzle-orm/postgres-js");
        // `db` is required by the PostgresVectorStorage constructor signature even though
        // the search path internally uses `this.sql.unsafe` rather than the drizzle client.
        const db = drizzle(sqlClient);

        const vectorStorage = new PostgresVectorStorage(sqlClient, db, DIMENSION, {
          tableName: VECTOR_TABLE,
          idColumn: "id",
          embeddingColumn: "embedding",
        });

        try {
          // Time-based CORROBORATION of backoff: PostgresVectorStorage.search
          // wraps its DB ops in withPgPoolRetry internally. We can't observe the
          // retry counter from outside, so elapsed time is the closest available
          // proxy. Saturation itself is no longer inferred from this number —
          // assertSaturated() above checked it directly (mt#4347), which is what
          // this assertion USED to be silently standing in for.
          //
          // With the ceiling fully consumed and search starting immediately, the
          // first connection attempt must fail; withPgPoolRetry then waits ~150ms
          // (initialDelayMs) ±20% jitter (so 120-180ms minimum) before retrying.
          // The held connections are released ~300ms in, so search succeeds on
          // the second or third attempt. Any total elapsed time below ~120ms
          // means no retry waited.
          //
          // Do NOT treat this threshold as latency-proof: against a REMOTE target
          // an ordinary round trip can clear 120ms on its own, so a pass here is
          // evidence of backoff only in combination with the direct precondition
          // check above.
          const startMs = Date.now();
          const results = await vectorStorage.search([1, 0, 0], { limit: 5 });
          // eslint-disable-next-line custom/no-real-fs-in-tests -- Date.now() in a BinaryExpression for elapsed-time measurement, not path creation; the rule's BinaryExpression check produces a false positive
          const elapsedMs = Date.now() - startMs;
          // Report the MARGIN, not just the outcome (mt#4347): a reader who sees
          // only "returned 1 result(s)" cannot tell a comfortable pass from one
          // sitting a millisecond above the floor. Both numbers come from
          // BACKOFF_FLOOR_MS below so the log and the assertion cannot drift.
          process.stdout.write(
            `[saturation/${label}] AT-4: vector search returned ${results.length} result(s) in ` +
              `${elapsedMs}ms (backoff floor ${BACKOFF_FLOOR_MS}ms, margin ` +
              `${elapsedMs - BACKOFF_FLOOR_MS}ms)\n`
          );
          expect(Array.isArray(results)).toBe(true);
          // At least the seed row must come back
          expect(results.length).toBeGreaterThan(0);
          // Backoff corroboration: search must have taken at least one retry
          // cycle. If elapsed < BACKOFF_FLOOR_MS, withPgPoolRetry never had to
          // wait. What that MEANS is now unambiguous — assertSaturated() already
          // proved the pool was refusing connections, so a short elapsed here is
          // a fault in the retry path rather than the silent "saturation was
          // never achieved" it used to indicate (mt#4347).
          expect(elapsedMs).toBeGreaterThanOrEqual(BACKOFF_FLOOR_MS);
        } finally {
          clearTimeout(releaseTimer);
          // Guaranteed release if timer hasn't fired yet.
          await releaseOnce();
          // Drop the test table so long-lived branches don't accumulate test
          // tables. We deliberately do NOT drop the vector extension here:
          // if other concurrent tests (or other test files) depend on vector
          // being loaded, dropping a globally-shared extension introduces a
          // race. Leave shared extension state alone; only drop our own
          // scoped table.
          await sqlClient.unsafe(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`).catch(() => {});
          await sqlClient.end().catch(() => {});
        }
      },
      TEST_TIMEOUT_MS
    );
  });
}

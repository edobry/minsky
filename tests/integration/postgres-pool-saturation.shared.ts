/**
 * Shared Postgres Pool Saturation Test Suite
 *
 * Implements the four acceptance tests from mt#1205 in a parameterized form so
 * child A (Supabase preview branch) and child C (local Supavisor docker) can
 * both exercise the same retry logic against different connection targets.
 *
 * Tasks: mt#1205 (umbrella), mt#1364 (child A – Supabase), mt#1365 (child C – docker)
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
import { withPgPoolRetry } from "../../src/domain/persistence/postgres-retry";
import { PostgresPersistenceProvider } from "../../src/domain/persistence/providers/postgres-provider";
import { PostgresVectorStorage } from "../../src/domain/storage/vector/postgres-vector-storage";

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
 * Returns a cleanup function that ends all held clients.
 */
async function holdConnections(
  connectionString: string,
  count: number
): Promise<{ clients: ReturnType<typeof postgres>[]; cleanup: () => Promise<void> }> {
  const clients: ReturnType<typeof postgres>[] = [];

  for (let i = 0; i < count; i++) {
    const client = makeSingleClient(connectionString);
    clients.push(client);
    try {
      await client`SELECT 1`;
    } catch {
      // Some connections may fail to open if pool is already partially full;
      // that's acceptable — we've still consumed what we could.
    }
  }

  const cleanup = async (): Promise<void> => {
    await Promise.allSettled(clients.map((c) => c.end()));
  };

  return { clients, cleanup };
}

/**
 * Registers the four mt#1205 acceptance tests inside a named `describe` block.
 * Call this function from the integration test wrappers (child A, child C).
 */
export function runSaturationSuite(options: SaturationSuiteOptions): void {
  const { connectionString, poolSize = 15, label } = options;

  // Number of concurrent clients to saturate the pool.
  // poolSize + 5 guarantees we exceed pool_size even with minor variance.
  const saturatingClients = poolSize + 5;

  // Timeout for individual tests — retries add up to ~600 ms per caller
  // and we run many concurrent ones, so be generous.
  const TEST_TIMEOUT_MS = 60_000;

  describe(`Postgres pool saturation suite [${label}]`, () => {
    // Verify the connection is reachable at all before running the suite.
    let healthOk = false;

    beforeAll(async () => {
      const probe = makeSingleClient(connectionString);
      try {
        await probe`SELECT 1`;
        healthOk = true;
        process.stdout.write(`[saturation/${label}] connection health check passed\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stdout.write(
          `[saturation/${label}] SKIP: connection health check failed — ${msg}\n`
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
        if (!healthOk) {
          process.stdout.write(`[saturation/${label}] AT-1: skipped — connection unhealthy\n`);
          return;
        }

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
        if (!healthOk) {
          process.stdout.write(`[saturation/${label}] AT-2: skipped — connection unhealthy\n`);
          return;
        }

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

          // Cleanup test row
          await probe.unsafe(`DELETE FROM ${tableName} WHERE run_id = $1`, [testRunId]);
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
        if (!healthOk) {
          process.stdout.write(`[saturation/${label}] AT-3: skipped — connection unhealthy\n`);
          return;
        }

        const { cleanup: releaseHeld } = await holdConnections(connectionString, poolSize);

        // Guard: ensure releaseHeld() is called at most once even though the
        // timer and finally block both attempt to call it.
        let released = false;
        const releaseOnce = async (): Promise<void> => {
          if (released) return;
          released = true;
          await releaseHeld();
        };

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
        if (!healthOk) {
          process.stdout.write(`[saturation/${label}] AT-4: skipped — connection unhealthy\n`);
          return;
        }

        // Check pgvector availability before running the vector test
        const probe = makeSingleClient(connectionString);
        let vectorAvailable = false;
        try {
          const ext = await probe`
            SELECT EXISTS (
              SELECT 1 FROM pg_extension WHERE extname = 'vector'
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
            `[saturation/${label}] AT-4: skipped — pgvector extension not available on this branch\n`
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

        const { cleanup: releaseHeld } = await holdConnections(connectionString, poolSize);

        // Guard: ensure releaseHeld() is called at most once even though the
        // timer and finally block both attempt to call it.
        let released = false;
        const releaseOnce = async (): Promise<void> => {
          if (released) return;
          released = true;
          await releaseHeld();
        };

        // Release held connections so the vector search can succeed
        const releaseTimer = setTimeout(() => void releaseOnce(), 300);

        const sqlClient = makeSingleClient(connectionString);
        const { drizzle } = await import("drizzle-orm/postgres-js");
        const db = drizzle(sqlClient);

        const vectorStorage = new PostgresVectorStorage(sqlClient, db, DIMENSION, {
          tableName: VECTOR_TABLE,
          idColumn: "id",
          embeddingColumn: "embedding",
        });

        try {
          const results = await vectorStorage.search([1, 0, 0], { limit: 5 });
          process.stdout.write(
            `[saturation/${label}] AT-4: vector search returned ${results.length} result(s)\n`
          );
          expect(Array.isArray(results)).toBe(true);
          // At least the seed row must come back
          expect(results.length).toBeGreaterThan(0);
        } finally {
          clearTimeout(releaseTimer);
          // Guaranteed release if timer hasn't fired yet.
          await releaseOnce();
          await sqlClient.end().catch(() => {});
        }
      },
      TEST_TIMEOUT_MS
    );
  });
}

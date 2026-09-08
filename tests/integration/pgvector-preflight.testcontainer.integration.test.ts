/**
 * mt#5016 AT1/AT2 — the pgvector preflight, wired, against a REAL Postgres.
 *
 * PR #3678 R1 (non-blocking): the unit tests exercise the preflight HELPER but
 * nothing failed if the call were removed from `runPostgresSchemaMigrations`, or
 * moved after work had already started. This is that coverage, and it is
 * deliberately an integration test rather than a seam: the property under test
 * is "no DDL reached the database", which only a database can report. A fake
 * that reports it would be asserting its own script (mem#704).
 *
 * It also makes the manual live verification from mt#5016's closeout permanent —
 * that run produced the right answer once, in a terminal, and left nothing that
 * would notice a regression.
 *
 * TWO containers, because a preflight that ALWAYS refused would pass the
 * negative case alone:
 *   - `postgres:16-alpine` — no pgvector. Must REFUSE, and write nothing.
 *   - `pgvector/pgvector:pg16` — has it. Must PERMIT.
 * The pgvector image is pinned at pg16 to match the sibling suites and CI, which
 * already pull it; the preflight is version-independent, so matching the
 * already-cached tag costs nothing and saves a pull.
 *
 * Gate: TWO env vars, both required (matching the sibling harnesses):
 *   RUN_INTEGRATION_TESTS=1
 *   RUN_TESTCONTAINER_TESTS=1
 *
 * Run:
 *   RUN_INTEGRATION_TESTS=1 RUN_TESTCONTAINER_TESTS=1 \
 *     bun test --preload ./tests/setup.ts --timeout=300000 \
 *       tests/integration/pgvector-preflight.testcontainer.integration.test.ts
 */
import { describe, test, expect, afterAll } from "bun:test";
import { GenericContainer, type StartedTestContainer, type WaitStrategy } from "testcontainers";
import postgres from "postgres";
import { runPostgresSchemaMigrations } from "../../packages/domain/src/persistence/postgres-migration-operations";
import {
  probePgvectorAvailability,
  PgvectorUnavailableError,
} from "../../packages/domain/src/persistence/pgvector-preflight";

const GATED =
  process.env.RUN_INTEGRATION_TESTS === "1" && process.env.RUN_TESTCONTAINER_TESTS === "1";

/** A Postgres that does NOT ship pgvector — what `minsky setup db` used to print. */
const PLAIN_IMAGE = "postgres:16-alpine";
/** A Postgres that DOES — what it prints now. */
const PGVECTOR_IMAGE = "pgvector/pgvector:pg16";

/**
 * No-op wait strategy — every built-in testcontainers strategy hangs under Bun
 * (docker-socket/child_process polling incompatibility). Readiness is the SQL
 * probe below. Copied from the sibling harnesses deliberately rather than
 * shared: coupling the suites through a shared export makes either one's
 * bring-up changes break the other.
 */
function makeNoOpWaitStrategy(defaultTimeoutMs: number): WaitStrategy {
  let storedTimeoutMs: number | undefined;
  const strategy: WaitStrategy = {
    async waitUntilReady(): Promise<void> {},
    getStartupTimeout: () => storedTimeoutMs ?? defaultTimeoutMs,
    withStartupTimeout(ms: number) {
      storedTimeoutMs = ms;
      return strategy;
    },
  } as unknown as WaitStrategy;
  return strategy;
}

const containers: StartedTestContainer[] = [];
const openClients: ReturnType<typeof postgres>[] = [];
const urlByImage = new Map<string, Promise<string>>();

afterAll(async () => {
  await Promise.all(openClients.splice(0).map((c) => c.end({ timeout: 5 })));
  await Promise.all(
    containers.splice(0).map((c) =>
      c.stop().catch(() => {
        // intentional-swallow: a container that failed to stop cannot fail the
        // run — the tests already have their verdict, and Docker reaps it anyway.
      })
    )
  );
});

/** Bring up (once, lazily) a container for the given image; returns its URL. */
async function ensureContainer(image: string): Promise<string> {
  let url = urlByImage.get(image);
  if (!url) {
    url = bringUpContainer(image);
    urlByImage.set(image, url);
  }
  return url;
}

async function bringUpContainer(image: string): Promise<string> {
  const started = await new GenericContainer(image)
    .withEnvironment({ POSTGRES_PASSWORD: "test", POSTGRES_USER: "test", POSTGRES_DB: "test" })
    .withExposedPorts(5432)
    .withWaitStrategy(makeNoOpWaitStrategy(120_000))
    .start();
  containers.push(started);

  const url = `postgres://test:test@${started.getHost()}:${started.getMappedPort(5432)}/test`;
  const probe = postgres(url, { max: 1, onnotice: () => {} });
  try {
    for (let i = 0; i < 60; i++) {
      try {
        await probe`SELECT 1`;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } finally {
    await probe.end();
  }
  return url;
}

/** A client on the given URL, closed in afterAll. */
function client(url: string): ReturnType<typeof postgres> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  openClients.push(sql);
  return sql;
}

describe.skipIf(!GATED)("pgvector preflight against a real Postgres (mt#5016)", () => {
  test("reads the real catalog: unavailable on a plain image, available on pgvector's", async () => {
    // This pair is what makes every assertion below meaningful. A probe that
    // returned "unavailable" unconditionally would satisfy the refusal test on
    // its own; only the second half shows it is reading something real.
    const plain = client(await ensureContainer(PLAIN_IMAGE));
    const withVector = client(await ensureContainer(PGVECTOR_IMAGE));

    expect(await probePgvectorAvailability(plain)).toBe("unavailable");
    // Not yet CREATEd on a fresh container — "available" is the correct answer,
    // and is what lets the bootstrap snapshot's own CREATE EXTENSION succeed.
    expect(await probePgvectorAvailability(withVector)).toBe("available");
  }, 300_000);

  test("runPostgresSchemaMigrations REFUSES on a Postgres without pgvector", async () => {
    const url = await ensureContainer(PLAIN_IMAGE);
    await expect(runPostgresSchemaMigrations(url, { dryRun: false })).rejects.toBeInstanceOf(
      PgvectorUnavailableError
    );
  }, 300_000);

  // AT2. Measured, not assumed — and the measurement corrected the claim this
  // comment originally made.
  //
  // Moving `assertPgvectorAvailableForMigration` to AFTER the bootstrap block
  // was run as a control. This test still PASSED: `bootstrapFreshPostgres`
  // wraps every statement plus the ledger stamp in one `sql.begin(...)`, so a
  // failure there rolls back and leaves zero tables either way. What caught the
  // move was the REFUSAL test above, which went red because the raw
  // `CREATE EXTENSION` error arrives instead of `PgvectorUnavailableError`.
  //
  // So the two tests divide the work, and neither subsumes the other: the
  // refusal test pins WHERE the preflight runs, and this one pins that no DDL
  // escapes a rollback — which is the property that stops holding the moment
  // anything on the migration path runs outside that transaction.
  test("the refusal leaves the database untouched — no tables, no drizzle ledger", async () => {
    const url = await ensureContainer(PLAIN_IMAGE);
    const sql = client(url);

    await runPostgresSchemaMigrations(url, { dryRun: false }).catch(() => {
      // intentional-swallow: the rejection is asserted by the test above; here
      // the subject is the DATABASE's state afterwards, not the error.
    });

    const tables = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    expect(tables[0]?.count).toBe("0");

    const ledgerSchema = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM pg_namespace WHERE nspname = 'drizzle'
    `;
    expect(ledgerSchema[0]?.count).toBe("0");
  }, 300_000);
});

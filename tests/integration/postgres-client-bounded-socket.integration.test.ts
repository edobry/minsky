/**
 * mt#3592 AT1 — a client built by `buildPostgresClient` connects to a REAL
 * Postgres and round-trips a query.
 *
 * ## Why this test exists
 *
 * mt#3092 shipped a custom `socket` factory into this same constructor, passed
 * four unit tests, a negative control, sixteen CI checks and a clean review, and
 * took production down: the factory returned an UNCONNECTED socket, so every
 * write failed with `Socket is closed` in every Minsky process that talks to
 * Postgres. Nothing caught it because `buildPostgresClient` was referenced in
 * exactly two files repo-wide — both source — and **no test opened a connection
 * through it**. Any test that does not connect cannot catch that class of
 * defect, no matter how many of them there are.
 *
 * So this test asserts the least clever thing available: build the production
 * client the production way, and get a row back.
 *
 * ## Why plain Postgres rather than the Supabase job
 *
 * Nothing here needs a pooler. Same reasoning as
 * `transcript-metadata-fill-if-null.integration.test.ts` (mt#3349): the
 * `supabase` job is gated on a secret that is currently unset (mt#3356), while
 * the `Integration (Postgres service container)` job runs free on every PR.
 *
 * Skips (does not fail) without a database:
 *
 *   RUN_INTEGRATION_TESTS=1
 *   INTEGRATION_POSTGRES_URL=<postgres connection string>
 *
 * @see mt#3592 — the socket inactivity bound this guards
 * @see mt#3092 — the attempt that shipped unexercised, and its post-mortem
 * @see packages/domain/src/persistence/providers/postgres-provider.ts — buildPostgresClient
 */
import { describe, test, expect } from "bun:test";
import { buildPostgresClient } from "@minsky/domain/persistence/providers/postgres-provider";

const POSTGRES_URL = process.env.INTEGRATION_POSTGRES_URL;
const ENABLED = process.env.RUN_INTEGRATION_TESTS === "1" && Boolean(POSTGRES_URL);

describe.skipIf(!ENABLED)("buildPostgresClient against a real Postgres (mt#3592)", () => {
  test("connects and round-trips a query", async () => {
    const sql = buildPostgresClient({ connectionString: POSTGRES_URL as string });
    try {
      const rows = await sql`SELECT 1 AS one`;
      expect(rows[0]?.one).toBe(1);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  test("the bounded-socket factory is the one that carried the connection", async () => {
    // Guards against the bound being silently dropped from the options while the
    // test above keeps passing on postgres-js's own default socket.
    const sql = buildPostgresClient({ connectionString: POSTGRES_URL as string });
    try {
      expect(typeof (sql.options as unknown as Record<string, unknown>).socket).toBe("function");
      const rows = await sql`SELECT 2 AS two`;
      expect(rows[0]?.two).toBe(2);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  test("a query slower than the sampling interval is not severed", async () => {
    // The bound severs a socket with no bytes moving, and a query in flight moves
    // none while it waits. With the default 60s bound this must be a non-event —
    // if it were not, every ordinary query would be a coin flip.
    const sql = buildPostgresClient({ connectionString: POSTGRES_URL as string });
    try {
      const rows = await sql`SELECT pg_sleep(1), 3 AS three`;
      expect(rows[0]?.three).toBe(3);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  test("the client still works after sitting idle past the bound", async () => {
    // idleTimeout: 1 drives BOTH postgres-js's own idle_timeout and this bound
    // (they share the value by design), so the connection is torn down while
    // idle. What matters is that the teardown is survivable: the next query
    // reconnects rather than inheriting a dead socket. That is the churn-safety
    // half of the mechanism — a bound that repaired wedges by breaking healthy
    // clients would not be worth shipping.
    const sql = buildPostgresClient({
      connectionString: POSTGRES_URL as string,
      idleTimeout: 1,
    });
    try {
      const before = await sql`SELECT 4 AS four`;
      expect(before[0]?.four).toBe(4);

      await new Promise<void>((resolve) => setTimeout(resolve, 2_500));

      const after = await sql`SELECT 5 AS five`;
      expect(after[0]?.five).toBe(5);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 20_000);
});

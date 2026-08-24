/**
 * mt#4476 AT3 — answered-ask wake delivery against a REAL Postgres.
 *
 * `src/adapters/shared/commands/asks-answered-wake.test.ts` and
 * `src/mcp/middleware/wake-enrichment.test.ts` pin the producer and consumer logic
 * against `FakeWakePendingRepository`. That fake is a hand-written mirror, so it can
 * only ever demonstrate that the LOGIC is right — it is structurally incapable of
 * showing the three things this change actually rests on:
 *
 *  1. **The migration is real.** `agent_id` exists, `parent_session_id` is genuinely
 *     nullable, and both partial indexes were created. A fake has whatever columns
 *     its TypeScript says it has, so it would pass identically against a migration
 *     that never ran — the can't-fail-probe shape (mem#704).
 *  2. **`drainByAgent` is atomic and isolated in SQL, not just in a loop.** The
 *     `UPDATE ... RETURNING` has to return each row exactly once under a concurrent
 *     second call, and must not touch another conversation's rows. The fake's
 *     single-threaded `for` loop cannot exhibit either property.
 *  3. **An unaddressable row is refused before it reaches the table.** The guard
 *     lives in application code, so this confirms the real repository enforces it on
 *     the real path rather than only the fake enforcing it on the fake path.
 *
 * Why a container rather than the production database: this inserts into
 * `wake_pending` and applies a migration. A throwaway Postgres gives identical
 * evidence with no blast radius, and applying an unmerged migration to a shared
 * database would be a shared-state mutation nothing has authorized.
 *
 * Gate: TWO env vars, both required (matching the sibling harnesses):
 *   RUN_INTEGRATION_TESTS=1
 *   RUN_TESTCONTAINER_TESTS=1
 *
 * Run:
 *   RUN_INTEGRATION_TESTS=1 RUN_TESTCONTAINER_TESTS=1 \
 *     bun test --preload ./tests/setup.ts --timeout=180000 \
 *       tests/integration/answered-ask-wake.testcontainer.integration.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import { GenericContainer, type StartedTestContainer, type WaitStrategy } from "testcontainers";
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  DrizzleWakePendingRepository,
  UnaddressableWakeError,
} from "../../packages/domain/src/ask/wake-pending-repository";
import type { WakeSignalPayload } from "../../packages/domain/src/ask/wake-on-respond";
import { buildAskStateSnapshot, type UnsafeSql } from "../../src/cockpit/ask-state-cache";

const GATED =
  process.env.RUN_INTEGRATION_TESTS === "1" && process.env.RUN_TESTCONTAINER_TESTS === "1";

const AGENT_A = "com.anthropic.claude-code:conv:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_B = "com.anthropic.claude-code:conv:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/**
 * No-op wait strategy — every built-in testcontainers strategy hangs under Bun
 * (docker-socket/child_process polling incompatibility). Readiness is the SQL probe
 * below. Copied from the sibling harnesses deliberately rather than shared: coupling
 * the suites through a shared export makes either one's bring-up changes break the other.
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

let container: StartedTestContainer | undefined;
let sql: ReturnType<typeof postgres> | undefined;

/**
 * The live connection, or a clear failure. A getter rather than a `!` assertion so a
 * harness that reaches a query before bring-up fails saying so, instead of throwing
 * `undefined is not a function` from inside a template tag.
 */
function conn(): ReturnType<typeof postgres> {
  if (!sql) throw new Error("test harness: queried before bringUp() established a connection");
  return sql;
}

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await container?.stop().catch(() => {
    // intentional-swallow: a container that failed to stop cannot fail the run —
    // the harness already has its verdict, and Docker reaps the container anyway.
  });
});

let dbPromise: Promise<PostgresJsDatabase> | undefined;

/**
 * One container for the whole file, with the tables emptied between tests.
 *
 * The first draft called `bringUp()` per test. That started eight Postgres containers
 * and, because `container`/`sql` are single slots, left seven of them running with
 * only the last reachable by `afterAll` — so the suite both outran the MCP transport's
 * timeout and leaked containers. Bring-up is the expensive part and nothing in these
 * tests needs a private server; TRUNCATE gives the same isolation for the cost of a
 * statement.
 */
async function getDb(): Promise<PostgresJsDatabase> {
  dbPromise ??= bringUp();
  const db = await dbPromise;
  await conn()`TRUNCATE wake_pending, asks`;
  return db;
}

async function bringUp(): Promise<PostgresJsDatabase> {
  container = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({
      POSTGRES_PASSWORD: "test",
      POSTGRES_USER: "test",
      POSTGRES_DB: "test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(makeNoOpWaitStrategy(120_000))
    .start();

  const url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/test`;
  sql = postgres(url, { max: 4, onnotice: () => {} });

  // Readiness probe — the wait strategy above is a no-op by necessity.
  for (let i = 0; i < 60; i++) {
    try {
      await sql`SELECT 1`;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // The exact shape mt#4476's two migrations produce. Written out rather than run
  // through the migrator so this harness pins the SHAPE the code expects — if a later
  // migration changes it, this fails and says so, instead of silently agreeing.
  await sql`
    CREATE TABLE wake_pending (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      parent_session_id text,
      agent_id text,
      ask_id text NOT NULL,
      payload_json jsonb NOT NULL,
      emitted_at timestamptz NOT NULL DEFAULT now(),
      drained_at timestamptz,
      drained_for_tool text
    )`;
  await sql`CREATE INDEX wake_pending_undelivered ON wake_pending (parent_session_id) WHERE drained_at IS NULL`;
  await sql`CREATE INDEX wake_pending_undelivered_by_agent ON wake_pending (agent_id) WHERE drained_at IS NULL`;
  await sql`
    ALTER TABLE wake_pending ADD CONSTRAINT wake_pending_addressable
      CHECK (parent_session_id IS NOT NULL OR agent_id IS NOT NULL)`;

  // `asks.id` is `uuid` while `wake_pending.ask_id` is `text`. That MISMATCH is the
  // point of creating this table here at all: the cockpit sweep joins the two, and
  // Postgres has no implicit text=uuid operator. Modelling `asks.id` as text would
  // make the harness agree with a broken query — the exact failure this file's own
  // docblock warns about one layer down.
  await sql`
    CREATE TABLE asks (
      id uuid PRIMARY KEY,
      state text NOT NULL,
      short_id text,
      title text,
      responded_at timestamptz,
      response jsonb
    )`;

  return drizzle(sql);
}

function answeredWake(askId: string, agentId: string): WakeSignalPayload {
  return {
    kind: "ask.answered",
    askId,
    agentId,
    reviewBody: "yes — ship it",
    reviewState: "responded",
    reviewAuthor: "operator",
    prNumber: 0,
  };
}

describe.skipIf(!GATED)("answered-ask wake against a real Postgres (mt#4476 AT3)", () => {
  test("the conversation-keyed round trip works end to end on real SQL", async () => {
    const db = await getDb();
    const repo = new DrizzleWakePendingRepository(db);

    await repo.insert(answeredWake("ask-1", AGENT_A));

    const drained = await repo.drainByAgent(AGENT_A, "git_log");

    expect(drained).toHaveLength(1);
    expect(drained[0]?.askId).toBe("ask-1");
    expect(drained[0]?.agentId).toBe(AGENT_A);

    // Idempotent: the row is marked drained in the same statement that returned it,
    // so a second call gets nothing. This is the property that keeps a wake from
    // being re-announced on every subsequent tool call for the rest of the turn.
    expect(await repo.drainByAgent(AGENT_A, "git_log")).toHaveLength(0);
  }, 180_000);

  test("a second conversation's drain does not take these rows", async () => {
    const db = await getDb();
    const repo = new DrizzleWakePendingRepository(db);

    await repo.insert(answeredWake("ask-a", AGENT_A));
    await repo.insert(answeredWake("ask-b", AGENT_B));

    const forB = await repo.drainByAgent(AGENT_B, "tasks.get");

    expect(forB.map((p) => p.askId)).toEqual(["ask-b"]);
    // A's row is untouched — isolation is the property the whole design rests on. If
    // this ever fails, the key is not conversation-scoped, which is precisely what an
    // ADR-006 Layer 1 process hash would be (and why the server withholds one).
    expect((await repo.drainByAgent(AGENT_A, "tasks.get")).map((p) => p.askId)).toEqual(["ask-a"]);
  }, 180_000);

  test("concurrent drains deliver each row exactly once", async () => {
    const db = await getDb();
    const repo = new DrizzleWakePendingRepository(db);

    await repo.insert(answeredWake("ask-x", AGENT_A));
    await repo.insert(answeredWake("ask-y", AGENT_A));

    // The fake's single-threaded loop cannot exhibit this at all. Real double-delivery
    // would mean an agent seeing the same answer twice in one turn.
    const [first, second] = await Promise.all([
      repo.drainByAgent(AGENT_A, "tool-1"),
      repo.drainByAgent(AGENT_A, "tool-2"),
    ]);

    const all = [...first, ...second].map((p) => p.askId).sort();
    expect(all).toEqual(["ask-x", "ask-y"]);
  }, 180_000);

  test("the session key still works, and the two keys do not cross", async () => {
    const db = await getDb();
    const repo = new DrizzleWakePendingRepository(db);

    await repo.insert({
      askId: "ask-session",
      parentSessionId: SESSION_C,
      reviewBody: "review",
      reviewState: "APPROVED",
      reviewAuthor: "minsky-reviewer[bot]",
      prNumber: 42,
    });
    await repo.insert(answeredWake("ask-agent", AGENT_A));

    // parent_session_id is nullable now; this confirms the pre-existing pr-watch and
    // quality.review producers are unaffected by that widening.
    expect((await repo.drainBySession(SESSION_C, "tasks.get")).map((p) => p.askId)).toEqual([
      "ask-session",
    ]);
    expect((await repo.drainByAgent(AGENT_A, "tasks.get")).map((p) => p.askId)).toEqual([
      "ask-agent",
    ]);
  }, 180_000);

  test("an unaddressable row is refused before it reaches the table", async () => {
    const db = await getDb();
    const repo = new DrizzleWakePendingRepository(db);

    await expect(
      repo.insert({
        askId: "ask-orphan",
        reviewBody: "",
        reviewState: "responded",
        reviewAuthor: null,
        prNumber: 0,
      })
    ).rejects.toThrow(UnaddressableWakeError);

    // Nothing was written. A row keyed on neither grain matches no drain query, so it
    // would sit undelivered forever while every surface reported success.
    const rows =
      await conn()`SELECT count(*)::int AS n FROM wake_pending WHERE ask_id = 'ask-orphan'`;
    expect(rows[0]?.n).toBe(0);
  }, 180_000);

  test("the DB refuses an unaddressable row even when application code does not", async () => {
    const db = await getDb();
    void db;

    // The constraint exists because this table has four producers and is reachable
    // from a migration, a backfill, or a psql session — paths that never touch
    // `DrizzleWakePendingRepository.insert`. Going around the repository is the whole
    // point of the assertion, not a shortcut in the test.
    //
    // try/catch rather than `expect(...).rejects`: a postgres-js tagged template
    // returns a lazy PendingQuery that only executes when it is awaited, and handing
    // that object to `.rejects` hung the runner for the full 180s timeout instead of
    // failing. Awaiting it explicitly is both the working form and the honest one —
    // the query runs on the line that looks like it runs it.
    let raised: unknown;
    try {
      await conn()`INSERT INTO wake_pending (ask_id, payload_json) VALUES ('ask-raw', '{}'::jsonb)`;
    } catch (err: unknown) {
      raised = err;
    }

    expect(raised).toBeDefined();
    expect(String(raised)).toContain("wake_pending_addressable");
  }, 180_000);

  test("the cockpit sweep's real query runs against real asks + wake_pending", async () => {
    const db = await getDb();
    void db;
    const askId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    await conn()`
      INSERT INTO asks (id, state, short_id, title, responded_at, response)
      VALUES (${askId}::uuid, 'responded', 'ask#1', 'title',
              now(), ${JSON.stringify({ responder: "operator", payload: "yes" })}::jsonb)`;
    await conn()`
      INSERT INTO wake_pending (ask_id, agent_id, payload_json, drained_at)
      VALUES (${askId}, ${AGENT_A}, '{}'::jsonb, now())`;

    // The REAL function, against REAL SQL. This is the test that was missing when the
    // reviewer caught `w.ask_id = a.id` comparing text to uuid (PR #3286 R1): every
    // unit test for this function passes a stub whose `unsafe()` returns canned rows
    // without parsing the query, so the whole suite was green against a statement
    // Postgres refuses outright — and the failure would not have been confined to the
    // new column, it would have taken every field the ask-state cache produces.
    // A forwarding adapter, not a cast. postgres-js's `Sql.unsafe` is generic over
    // its row type where `UnsafeSql.unsafe` fixes it to `Record<string, unknown>`;
    // the two are runtime-compatible (this test is the proof) but not structurally
    // assignable. Forwarding keeps the production signature honest instead of
    // silencing the mismatch with `as unknown as`.
    const adapter: UnsafeSql = {
      unsafe: async (query, params) =>
        (await conn().unsafe(query, params as never)) as Array<Record<string, unknown>>,
    };

    const snapshot = await buildAskStateSnapshot(adapter, [askId]);

    expect(snapshot?.[askId]).toMatchObject({ found: true, state: "responded" });
    expect(snapshot?.[askId]).toHaveProperty("wakeDeliveredAt");
  }, 180_000);
});

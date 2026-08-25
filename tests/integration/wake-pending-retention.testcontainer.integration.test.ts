/**
 * mt#4537 AT1/AT2/AT3 — `wake_pending` retention against a REAL Postgres.
 *
 * The sweep is three SQL predicates and one cross-table `NOT EXISTS` per side. A
 * hand-written fake would have to reimplement those semantics to be exercised, and
 * would then be testing the reimplementation — the can't-fail-probe shape (mem#704).
 * Four things only real SQL can show:
 *
 *  1. **The delivered/undelivered split holds.** An undelivered row with a LIVE
 *     addressee must survive at any age; that is the loss mt#4517 closed, and it is the
 *     one behaviour worth a failing test.
 *  2. **`ask_id` may not be a uuid.** The column is unconstrained text (ADR-029), and
 *     production carries a row whose value joins to nothing. Casting the wrong side
 *     raises `invalid input syntax for type uuid` and takes the whole DELETE down — a
 *     fake has no types to get wrong.
 *  3. **The new partial index is usable by the cockpit's subquery.** A plan is a
 *     property of the planner, not of the code.
 *  4. **A delivered row inside the window still answers `wake_delivered_at`** — the
 *     cross-seam suppression the retention window exists to protect (SC5).
 *
 * Why a container rather than the production database: this deletes rows. A throwaway
 * Postgres gives identical evidence with no blast radius.
 *
 * Gate: TWO env vars, both required (matching the sibling harnesses):
 *   RUN_INTEGRATION_TESTS=1
 *   RUN_TESTCONTAINER_TESTS=1
 *
 * Run:
 *   RUN_INTEGRATION_TESTS=1 RUN_TESTCONTAINER_TESTS=1 \
 *     bun test --preload ./tests/setup.ts --timeout=300000 \
 *       tests/integration/wake-pending-retention.testcontainer.integration.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import { GenericContainer, type StartedTestContainer, type WaitStrategy } from "testcontainers";
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  runWakePendingRetentionSweep,
  WAKE_PENDING_DELIVERED_RETENTION_MS,
} from "../../packages/domain/src/ask/wake-pending-retention";
import { buildAskStateSnapshot, type UnsafeSql } from "../../src/cockpit/ask-state-cache";

const GATED =
  process.env.RUN_INTEGRATION_TESTS === "1" && process.env.RUN_TESTCONTAINER_TESTS === "1";

const LIVE_SESSION = "11111111-1111-4111-8111-111111111111";
const DEAD_SESSION = "22222222-2222-4222-8222-222222222222";
const AGENT = "com.anthropic.claude-code:conv:33333333-3333-4333-8333-333333333333";

const NOW = new Date("2026-08-25T00:00:00.000Z");
const OUTSIDE_WINDOW = new Date(NOW.getTime() - WAKE_PENDING_DELIVERED_RETENTION_MS - 60_000);
const INSIDE_WINDOW = new Date(NOW.getTime() - WAKE_PENDING_DELIVERED_RETENTION_MS + 60_000);

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

/** One container for the whole file, tables emptied between tests. */
async function getDb(): Promise<PostgresJsDatabase> {
  dbPromise ??= bringUp();
  const db = await dbPromise;
  await conn()`TRUNCATE wake_pending, asks, sessions`;
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

  for (let i = 0; i < 60; i++) {
    try {
      await sql`SELECT 1`;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // The shape migrations 0032 → 0108 produce, written out rather than run through the
  // migrator so this harness pins the SHAPE the sweep expects. If a later migration
  // changes it, this fails and says so instead of silently agreeing.
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
  // Migration 0108 — the index this task adds. Its predicate must match the cockpit
  // subquery's, which is what the plan assertion below checks.
  await sql`
    CREATE INDEX wake_pending_delivered_by_ask ON wake_pending (ask_id, drained_at)
      WHERE drained_at IS NOT NULL AND agent_id IS NOT NULL`;
  await sql`
    ALTER TABLE wake_pending ADD CONSTRAINT wake_pending_addressable
      CHECK (parent_session_id IS NOT NULL OR agent_id IS NOT NULL)`;

  // `asks.id` is uuid while `wake_pending.ask_id` is text. That mismatch is the point of
  // creating this table here: modelling `asks.id` as text would make the harness agree
  // with a query that raises in production.
  await sql`
    CREATE TABLE asks (
      id uuid PRIMARY KEY,
      state text NOT NULL,
      short_id text,
      title text,
      responded_at timestamptz,
      response jsonb
    )`;

  // Only the column the sweep reads. `session` (not `id`) is this table's primary key
  // in production — a detail worth pinning, since keying the NOT EXISTS on the wrong
  // column would silently make every session-keyed row look undeliverable.
  await sql`
    CREATE TABLE sessions (
      session varchar(255) PRIMARY KEY,
      repo_name varchar(255) NOT NULL DEFAULT 'test',
      repo_url varchar(1000) NOT NULL DEFAULT 'https://example.invalid/r.git',
      created_at timestamptz NOT NULL DEFAULT now()
    )`;

  return drizzle(sql);
}

/**
 * Insert one wake row directly — the producer's own guard is not what is under test.
 *
 * Both non-scalar parameters are stringified and cast in SQL rather than passed as a
 * JS value. Under Bun, `postgres.js` binds an object or a `Date` by byte-length and
 * throws `ERR_INVALID_ARG_TYPE` before the statement is sent. That is a property of
 * this raw-driver harness only: the production path goes through drizzle, which
 * serializes both itself — which is why the sweep under test takes a real `Date` for
 * `now` and works.
 */
async function seedWake(row: {
  askId: string;
  parentSessionId?: string;
  agentId?: string;
  drainedAt?: Date;
}): Promise<void> {
  await conn()`
    INSERT INTO wake_pending (parent_session_id, agent_id, ask_id, payload_json, drained_at)
    VALUES (
      ${row.parentSessionId ?? null},
      ${row.agentId ?? null},
      ${row.askId},
      ${JSON.stringify({ kind: "ask.answered", askId: row.askId, reviewBody: "ok" })}::jsonb,
      ${row.drainedAt?.toISOString() ?? null}::timestamptz
    )`;
}

async function seedAsk(id: string, state = "responded"): Promise<void> {
  await conn()`
    INSERT INTO asks (id, state, responded_at) VALUES (${id}, ${state}, now())`;
}

async function seedSession(id: string): Promise<void> {
  await conn()`INSERT INTO sessions (session) VALUES (${id})`;
}

async function remainingAskIds(): Promise<string[]> {
  const rows = await conn()`SELECT ask_id FROM wake_pending ORDER BY ask_id`;
  return rows.map((r) => String(r.ask_id));
}

const ASK_OLD_DELIVERED = "aaaaaaaa-0000-4000-8000-000000000001";
const ASK_RECENT_DELIVERED = "aaaaaaaa-0000-4000-8000-000000000002";
const ASK_LIVE_PENDING = "aaaaaaaa-0000-4000-8000-000000000003";
const ASK_DEAD_SESSION = "aaaaaaaa-0000-4000-8000-000000000004";

describe.skipIf(!GATED)("wake_pending retention against a real Postgres (mt#4537)", () => {
  test("AT1: deletes old-delivered and addressee-gone rows, keeps the other two", async () => {
    const db = await getDb();
    await seedSession(LIVE_SESSION);
    for (const id of [ASK_OLD_DELIVERED, ASK_RECENT_DELIVERED, ASK_LIVE_PENDING, ASK_DEAD_SESSION])
      await seedAsk(id);

    await seedWake({
      askId: ASK_OLD_DELIVERED,
      agentId: AGENT,
      drainedAt: OUTSIDE_WINDOW,
    });
    await seedWake({
      askId: ASK_RECENT_DELIVERED,
      agentId: AGENT,
      drainedAt: INSIDE_WINDOW,
    });
    await seedWake({ askId: ASK_LIVE_PENDING, parentSessionId: LIVE_SESSION });
    await seedWake({ askId: ASK_DEAD_SESSION, parentSessionId: DEAD_SESSION });

    const result = await runWakePendingRetentionSweep(db, { now: NOW });

    expect(result).toEqual({ deletedDelivered: 1, deletedUndeliverable: 1 });
    // The undelivered row with a LIVE addressee survives. That is the assertion this
    // whole file exists for: age is not evidence of undeliverability.
    expect(await remainingAskIds()).toEqual([ASK_RECENT_DELIVERED, ASK_LIVE_PENDING].sort());
  });

  test("deletes an undelivered row whose ask is gone, including a non-uuid ask_id", async () => {
    const db = await getDb();
    await seedSession(LIVE_SESSION);
    // Not a uuid at all — production carries one of these, and casting the wrong side
    // of the join would raise rather than return no rows.
    await seedWake({ askId: "not-a-uuid-at-all", parentSessionId: LIVE_SESSION });
    await seedWake({ askId: ASK_LIVE_PENDING, parentSessionId: LIVE_SESSION });
    await seedAsk(ASK_LIVE_PENDING);

    const result = await runWakePendingRetentionSweep(db, { now: NOW });

    expect(result.deletedUndeliverable).toBe(1);
    expect(await remainingAskIds()).toEqual([ASK_LIVE_PENDING]);
  });

  test("keeps an undelivered row whose ask is CLOSED — the deliberate exclusion", async () => {
    const db = await getDb();
    await seedSession(LIVE_SESSION);
    await seedAsk(ASK_LIVE_PENDING, "closed");
    await seedWake({ askId: ASK_LIVE_PENDING, parentSessionId: LIVE_SESSION });

    const result = await runWakePendingRetentionSweep(db, { now: NOW });

    // A closed ask does not mean the agent that filed it saw the answer.
    expect(result.deletedUndeliverable).toBe(0);
    expect(await remainingAskIds()).toEqual([ASK_LIVE_PENDING]);
  });

  test("keeps an agent-keyed undelivered row — conversation liveness is not decidable", async () => {
    const db = await getDb();
    await seedAsk(ASK_LIVE_PENDING);
    await seedWake({ askId: ASK_LIVE_PENDING, agentId: AGENT });

    const result = await runWakePendingRetentionSweep(db, { now: NOW });

    expect(result.deletedUndeliverable).toBe(0);
    expect(await remainingAskIds()).toEqual([ASK_LIVE_PENDING]);
  });

  test("AT3/SC5: a delivered row inside the window still answers wake_delivered_at", async () => {
    const db = await getDb();
    await seedAsk(ASK_RECENT_DELIVERED);
    await seedWake({
      askId: ASK_RECENT_DELIVERED,
      agentId: AGENT,
      drainedAt: INSIDE_WINDOW,
    });

    await runWakePendingRetentionSweep(db, { now: NOW });

    // The cockpit's own subquery, unchanged — the prompt seam suppresses on this field,
    // and nothing else records that the tool seam already delivered the answer.
    const snapshot = await buildAskStateSnapshot(conn() as unknown as UnsafeSql, [
      ASK_RECENT_DELIVERED,
    ]);
    const entry = snapshot?.[ASK_RECENT_DELIVERED];
    // `found !== true` is the same narrowing the prompt-seam hook applies before
    // reading this field — an absent entry and a not-found one are different facts,
    // and neither carries a delivery timestamp.
    if (!entry || entry.found !== true) {
      throw new Error("ask-state snapshot did not find the seeded ask");
    }
    expect(entry.wakeDeliveredAt).toBeTruthy();
  });

  test("AT2 (after-plan): the cockpit subquery uses wake_pending_delivered_by_ask", async () => {
    await getDb();
    await seedAsk(ASK_RECENT_DELIVERED);

    // A four-row table is always a seq scan, so the plan would prove nothing. Enough
    // rows that an index scan is the cheaper plan is the only way to ask the planner a
    // real question.
    await conn()`
      INSERT INTO wake_pending (agent_id, ask_id, payload_json, drained_at)
      SELECT ${AGENT}, gen_random_uuid()::text, '{}'::jsonb, now()
      FROM generate_series(1, 5000)`;
    await seedWake({ askId: ASK_RECENT_DELIVERED, agentId: AGENT, drainedAt: INSIDE_WINDOW });
    await conn()`ANALYZE wake_pending`;

    const plan = await conn().unsafe(
      "EXPLAIN (COSTS OFF) SELECT a.id, " +
        "(SELECT max(w.drained_at) FROM public.wake_pending w " +
        " WHERE w.ask_id = a.id::text AND w.drained_at IS NOT NULL " +
        " AND w.agent_id IS NOT NULL) AS wake_delivered_at " +
        "FROM public.asks a WHERE a.id = ANY($1::uuid[])",
      [[ASK_RECENT_DELIVERED]]
    );
    const rendered = plan.map((r) => String(Object.values(r)[0])).join("\n");

    // With the index the aggregate collapses to a backward Index Only Scan under a
    // Limit — `max(drained_at)` for one ask read straight off the index, no heap visit.
    // Both halves matter: the name alone would pass on a plan that also seq-scanned.
    expect(rendered).toContain("wake_pending_delivered_by_ask");
    expect(rendered).not.toContain("Seq Scan on wake_pending");
  });
});

/**
 * mt#4294 — the maintained fire-log lifetime rollup, against a real Postgres.
 *
 * `packages/domain/src/guard-events/fire-log-rollup.test.ts` pins the FOLDING
 * RULES (which stream counts, how a null `occurred_at` behaves) as pure values.
 * This file pins the properties those rules cannot demonstrate on their own,
 * because they are properties of SQL and of a transaction:
 *
 *  1. The rollup EQUALS a direct `GROUP BY` recompute over the corpus. This is
 *     the whole claim — `fetchFireLogLifetime` no longer aggregates
 *     `guard_events`, so if the maintained value drifts, every reader is wrong
 *     together and nothing anywhere raises an error.
 *  2. RE-INGESTING the same records folds NOTHING. The rollup is maintained
 *     from the insert's `RETURNING` set, so its exactness rests entirely on
 *     `ON CONFLICT (dedupe_key) DO NOTHING` returning only genuinely-appended
 *     rows. A rollup that double-counted on re-ingest would look right until
 *     the first re-scan and then be permanently, silently too high.
 *  3. `LEAST`/`GREATEST` combine first/last-fire across BATCHES, not just
 *     within one. The pure test covers a single batch; the null-tolerance that
 *     matters in production is the stored-value-vs-incoming-value case.
 *
 * Why a container rather than the production database: this inserts and mutates
 * `guard_events`, which is the corpus the interceptor catalog reads. A
 * throwaway Postgres gives identical evidence with no blast radius — and the
 * task this belongs to exists because that table is already too expensive to
 * touch casually.
 *
 * Gate: TWO env vars, both required (matching the sibling harnesses):
 *   RUN_INTEGRATION_TESTS=1
 *   RUN_TESTCONTAINER_TESTS=1
 *
 * Run:
 *   RUN_INTEGRATION_TESTS=1 RUN_TESTCONTAINER_TESTS=1 \
 *     bun test --preload ./tests/setup.ts --timeout=180000 \
 *       tests/integration/fire-log-rollup.testcontainer.integration.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import { GenericContainer, type WaitStrategy } from "testcontainers";
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { buildInsertBatch } from "../../packages/domain/src/guard-events/ingest-runtime";
import {
  fetchFireLogLifetime,
  type FireLogLifetimeRow,
} from "../../packages/domain/src/guard-events/aggregates";
import { rebuildFireLogLifetimeRollup } from "../../packages/domain/src/guard-events/fire-log-rollup";
import type { GuardEventInsertRow } from "../../packages/domain/src/guard-events/ingest-service";

/**
 * No-op wait strategy — every built-in testcontainers strategy hangs under Bun
 * (docker-socket/child_process polling incompatibility). Readiness is the SQL
 * probe below. Copied from the sibling harnesses deliberately rather than
 * shared, for the reason stated in `sweeper-abandoned-tick`: coupling the
 * suites through a shared export makes either one's bring-up changes break the
 * other.
 */
function makeNoOpWaitStrategy(defaultTimeoutMs: number): WaitStrategy {
  let storedTimeoutMs: number | undefined;
  const strategy: WaitStrategy = {
    async waitUntilReady() {
      // Intentionally empty — readiness is the SQL probe below.
    },
    withStartupTimeout(timeoutMs: number) {
      storedTimeoutMs = timeoutMs;
      return strategy;
    },
    isStartupTimeoutSet() {
      return storedTimeoutMs !== undefined;
    },
    getStartupTimeout() {
      return storedTimeoutMs ?? defaultTimeoutMs;
    },
  };
  return strategy;
}

const POSTGRES_IMAGE = "postgres:16-alpine";

/**
 * Minimal DDL for the two tables under test.
 *
 * Deliberately hand-written rather than run through the migration chain: 101
 * migrations of unrelated history would be brought up to exercise two tables,
 * and a failure anywhere in that chain would present as a failure of this test.
 * The columns below are the ones the rollup path reads and writes; the shapes
 * are copied from `guard-events-schema.ts` and from migration
 * `0101_brave_stardust.sql`.
 */
const DDL = `
  -- Idempotent, and NOT required on this image (PR #3191 R1-R4).
  --
  -- The review's stated mechanism is wrong and the record should say so:
  -- gen_random_uuid() moved into Postgres CORE in 13, so on postgres:16-alpine
  -- it needs no extension, and this suite's tables were created and asserted
  -- against on six runs before this line existed. It is kept anyway for a
  -- reason that stands on its own: POSTGRES_IMAGE is a constant one edit away
  -- from an older tag, and a DDL that only works because of the pinned
  -- version's defaults is coupled to that pin without saying so. This makes it
  -- self-sufficient at the cost of a no-op.
  create extension if not exists pgcrypto;

  create table guard_events (
    id uuid primary key default gen_random_uuid(),
    stream text not null,
    family text not null,
    guard_name text,
    session_id text,
    project_id uuid,
    occurred_at timestamp with time zone,
    decision text,
    event text,
    duration_ms integer,
    payload jsonb not null,
    dedupe_key text not null,
    source_path text,
    ingested_at timestamp with time zone not null default now()
  );
  create unique index uq_guard_events_dedupe_key on guard_events (dedupe_key);

  create table guard_event_fire_log_rollup (
    guard_name text primary key,
    total_fires integer default 0 not null,
    first_fire_at timestamp with time zone,
    last_fire_at timestamp with time zone,
    updated_at timestamp with time zone default now() not null
  );
`;

function row(dedupeKey: string, over: Partial<GuardEventInsertRow> = {}): GuardEventInsertRow {
  return {
    stream: "fire-log",
    family: "fire-log",
    guardName: "alpha-guard",
    sessionId: null,
    projectId: null,
    occurredAt: new Date("2026-08-19T12:00:00Z"),
    decision: "deny",
    event: "fire",
    durationMs: 5,
    payload: {},
    dedupeKey,
    sourcePath: null,
    ...over,
  } as GuardEventInsertRow;
}

if (process.env.RUN_INTEGRATION_TESTS && process.env.RUN_TESTCONTAINER_TESTS) {
  process.stdout.write(`[mt4294/testcontainer] starting ${POSTGRES_IMAGE}\n`);

  const container = await new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_USER: "postgres",
      POSTGRES_DB: "postgres",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(makeNoOpWaitStrategy(120_000))
    .withStartupTimeout(120_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const connectionString = `postgresql://postgres:postgres@${host}:${port}/postgres`;

  // eslint-disable-next-line custom/no-real-fs-in-tests -- Date.now() is a timing deadline, not a path
  const probeDeadline = Date.now() + 60_000;
  let ready = false;
  // eslint-disable-next-line custom/no-real-fs-in-tests -- same: timing, not path construction
  while (Date.now() < probeDeadline) {
    try {
      const probe = postgres(connectionString, { max: 1, prepare: false, connect_timeout: 2 });
      try {
        await probe`SELECT 1`;
        ready = true;
        break;
      } finally {
        await probe.end().catch(() => {});
      }
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!ready) {
    await container.stop().catch(() => {});
    throw new Error(`[mt4294/testcontainer] readiness probe timed out at ${host}:${port}`);
  }
  process.stdout.write(`[mt4294/testcontainer] ready at ${host}:${port}\n`);

  const sql = postgres(connectionString, { max: 5, prepare: false });
  const db = drizzle(sql) as PostgresJsDatabase;
  await sql.unsafe(DDL);

  /** The independent truth the rollup is checked against. */
  async function recompute(): Promise<Map<string, number>> {
    const rows = await sql<{ guard_name: string; n: number }[]>`
      select guard_name, count(*)::int as n
      from guard_events
      where stream = 'fire-log' and guard_name is not null
      group by guard_name
    `;
    return new Map(rows.map((r) => [r.guard_name, r.n]));
  }

  async function lifetimeByGuard(): Promise<Map<string, FireLogLifetimeRow>> {
    const rows = await fetchFireLogLifetime(db);
    return new Map(rows.map((r) => [r.guardName, r]));
  }

  describe("mt#4294 — the fire-log lifetime rollup against a real Postgres", () => {
    afterAll(async () => {
      await sql.end().catch(() => {});
      await container.stop().catch(() => {});
    });

    test("the maintained rollup equals a direct recompute, and re-ingest folds nothing", async () => {
      const insertBatch = buildInsertBatch(db);

      const batch = [
        row("a-1"),
        row("a-2", { occurredAt: new Date("2026-08-19T09:00:00Z") }),
        row("a-3", { occurredAt: new Date("2026-08-19T18:00:00Z") }),
        row("b-1", { guardName: "beta-guard" }),
        // Another stream riding the same batch — must contribute nothing.
        row("h-1", { stream: "guard-health", family: "guard-health" }),
        // No guard name — must contribute nothing.
        row("n-1", { guardName: null }),
      ];

      const inserted = await insertBatch(batch);
      expect(inserted).toBe(6);

      const afterFirst = await lifetimeByGuard();
      expect(afterFirst.get("alpha-guard")?.totalFires).toBe(3);
      expect(afterFirst.get("beta-guard")?.totalFires).toBe(1);
      expect(afterFirst.has("guard-health")).toBe(false);

      // The equality claim, against SQL rather than against our own arithmetic.
      const truth = await recompute();
      for (const [guardName, expected] of truth) {
        expect(afterFirst.get(guardName)?.totalFires).toBe(expected);
      }
      expect(afterFirst.size).toBe(truth.size);

      // min/max across the batch.
      expect(afterFirst.get("alpha-guard")?.firstFireAt).toBe("2026-08-19T09:00:00.000Z");
      expect(afterFirst.get("alpha-guard")?.lastFireAt).toBe("2026-08-19T18:00:00.000Z");

      // RE-INGEST the identical batch. `ON CONFLICT DO NOTHING` appends nothing,
      // so the rollup must not move — this is the property that makes the
      // maintained value exact rather than merely plausible.
      const insertedAgain = await insertBatch(batch);
      expect(insertedAgain).toBe(0);

      const afterReingest = await lifetimeByGuard();
      expect(afterReingest.get("alpha-guard")?.totalFires).toBe(3);
      expect(afterReingest.get("beta-guard")?.totalFires).toBe(1);
      expect(await recompute()).toEqual(truth);
    });

    test("first/last fire combine ACROSS batches, and a later untimestamped batch does not clobber them", async () => {
      const insertBatch = buildInsertBatch(db);

      // Earlier than anything stored for alpha-guard, in its own batch — so the
      // combine happens between the STORED value and the incoming one, which is
      // the LEAST/GREATEST path the pure test cannot reach.
      await insertBatch([row("a-4", { occurredAt: new Date("2026-08-01T00:00:00Z") })]);
      await insertBatch([row("a-5", { occurredAt: new Date("2026-08-25T00:00:00Z") })]);

      let lifetime = await lifetimeByGuard();
      expect(lifetime.get("alpha-guard")?.firstFireAt).toBe("2026-08-01T00:00:00.000Z");
      expect(lifetime.get("alpha-guard")?.lastFireAt).toBe("2026-08-25T00:00:00.000Z");
      expect(lifetime.get("alpha-guard")?.totalFires).toBe(5);

      // A batch carrying no timestamp at all still COUNTS, and must leave the
      // established bounds alone rather than nulling them.
      await insertBatch([row("a-6", { occurredAt: null })]);

      lifetime = await lifetimeByGuard();
      expect(lifetime.get("alpha-guard")?.totalFires).toBe(6);
      expect(lifetime.get("alpha-guard")?.firstFireAt).toBe("2026-08-01T00:00:00.000Z");
      expect(lifetime.get("alpha-guard")?.lastFireAt).toBe("2026-08-25T00:00:00.000Z");

      expect(await recompute()).toEqual(
        new Map([...(await lifetimeByGuard())].map(([guardName, r]) => [guardName, r.totalFires]))
      );
    });

    test("a rebuild is idempotent and repairs a drifted rollup", async () => {
      // Drift the rollup deliberately — the failure mode with no error to
      // notice, and the reason `rebuildFireLogLifetimeRollup` exists at all.
      await sql`update guard_event_fire_log_rollup set total_fires = 9999 where guard_name = 'alpha-guard'`;
      expect((await lifetimeByGuard()).get("alpha-guard")?.totalFires).toBe(9999);

      const first = await rebuildFireLogLifetimeRollup(db);
      const truth = await recompute();
      expect(first.guardsRolledUp).toBe(truth.size);

      const repaired = await lifetimeByGuard();
      for (const [guardName, expected] of truth) {
        expect(repaired.get(guardName)?.totalFires).toBe(expected);
      }

      // Running it again changes nothing — it SETS from the recompute rather
      // than adding to what is there, so a second pass cannot compound.
      await rebuildFireLogLifetimeRollup(db);
      const afterSecond = await lifetimeByGuard();
      for (const [guardName, expected] of truth) {
        expect(afterSecond.get(guardName)?.totalFires).toBe(expected);
      }

      // A guard with no corpus rows is dropped, so a rebuild is a true
      // recompute rather than a monotonic union.
      await sql`insert into guard_event_fire_log_rollup (guard_name, total_fires) values ('ghost-guard', 42)`;
      await rebuildFireLogLifetimeRollup(db);
      expect((await lifetimeByGuard()).has("ghost-guard")).toBe(false);
    });

    test("an empty-string guard name folds and rebuilds IDENTICALLY (PR #3191 R1)", async () => {
      // The regression test for the reviewer's finding. The bug was invisible
      // to every other assertion here: the incremental fold skipped `""` while
      // the backfill and rebuild counted it, so the rollup was self-consistent
      // until something rebuilt it and the numbers moved. Only comparing the
      // two PATHS against each other can see it.
      const insertBatch = buildInsertBatch(db);
      await insertBatch([
        row("empty-1", { guardName: "" }),
        row("empty-2", { guardName: "" }),
        row("empty-3", { guardName: "" }),
      ]);

      const afterFold = await lifetimeByGuard();
      expect(afterFold.get("")?.totalFires).toBe(3);

      // Now rebuild from the corpus and require the SAME value. Before the fix
      // the fold produced no row at all here and the rebuild produced 3.
      await rebuildFireLogLifetimeRollup(db);
      const afterRebuild = await lifetimeByGuard();
      expect(afterRebuild.get("")?.totalFires).toBe(3);

      // And the general form: every guard agrees across both paths.
      const truth = await recompute();
      for (const [guardName, expected] of truth) {
        expect(afterFold.get(guardName)?.totalFires).toBe(expected);
        expect(afterRebuild.get(guardName)?.totalFires).toBe(expected);
      }
      expect(afterFold.size).toBe(truth.size);
      expect(afterRebuild.size).toBe(truth.size);
    });

    test("the single-guard read returns only that guard", async () => {
      const rows = await fetchFireLogLifetime(db, "beta-guard");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.guardName).toBe("beta-guard");
    });

    test("filtering by the EMPTY-STRING guard name filters, rather than returning everything (PR #3191 R2)", async () => {
      // The read-side half of R1's write-side bug, and a direct consequence of
      // fixing it: making `""` a valid guard name turned a latent truthiness
      // check into a live defect. `guardName ? eq(...) : undefined` drops the
      // filter for `""`, so the query returns the WHOLE population while the
      // caller believes it asked for one guard.
      //
      // This fails OPEN — more rows, all of them real — so nothing downstream
      // errors and the result reads as plausible. That is why it needs a test
      // rather than a careful reading.
      const all = await fetchFireLogLifetime(db);
      expect(all.length).toBeGreaterThan(1);

      const filtered = await fetchFireLogLifetime(db, "");
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.guardName).toBe("");
    });
  });
}

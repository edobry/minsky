/**
 * clear-ambiguous-spawn-links sweep — Testcontainers + real Postgres (mt#3976)
 *
 * Regression coverage for the mt#3976 production incident: the mt#3702 sweep
 * reported clearing 52 rows and cleared 26. Three defects produced that, and all
 * three are SQL-semantic — which is why this suite runs against a real Postgres
 * rather than a fake `db` (ADR-036 §1: a real dependency in a sandboxed
 * environment ranks above an injected fake):
 *
 *   1. `WHERE parent_tool_use_id = <NULL>` matches nothing. A fake `db` has no
 *      NULL semantics to get wrong, so it cannot express the defect at all.
 *   2. The loop counted statements, not affected rows. A fake's `execute` returns
 *      whatever the fake decides; only a real driver can be asked "how many rows
 *      did this actually change?"
 *   3. The verification re-read required two resolved rows per turn, so clearing
 *      one of a pair hid the other. Reproducing that needs a real GROUP BY over
 *      real rows.
 *
 * Two-level gate (mirrors the sibling testcontainer suites):
 *   RUN_INTEGRATION_TESTS=1
 *   RUN_TESTCONTAINER_TESTS=1
 *
 * Run:
 *   RUN_INTEGRATION_TESTS=1 RUN_TESTCONTAINER_TESTS=1 \
 *     bun test --preload ./tests/setup.ts --timeout=180000 \
 *       tests/integration/clear-ambiguous-spawn-links.testcontainer.integration.test.ts
 *
 * @see mt#3976 — this file's originating task
 * @see mt#3702 — the sweep being corrected
 */

import { afterAll, beforeEach, describe, test, expect } from "bun:test";
import { GenericContainer, type WaitStrategy } from "testcontainers";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql as drizzleSql } from "drizzle-orm";
import { join } from "path";
// eslint-disable-next-line custom/no-real-fs-in-tests -- reads the real committed migration journal, mirroring production's own bootstrap path (postgres-bootstrap.ts), not test-state faking
import { readFileSync } from "fs";
import {
  resolvePgMigrationsFolder,
  type Journal,
} from "@minsky/domain/persistence/postgres-migration-operations";
import { bootstrapFreshPostgres } from "@minsky/domain/persistence/postgres-bootstrap";
import {
  clearSweepTargets,
  countDistinctChildTurns,
  countOutstanding,
  exitCodeFor,
  runSweep,
  selectSweepTargets,
  type SweepOptions,
} from "../../scripts/clear-ambiguous-spawn-links";

// No-op wait strategy — see postgres-pool-saturation.testcontainer.integration.test.ts
// for the full rationale (every built-in testcontainers wait strategy hangs
// under Bun; readiness is determined by our own SQL probe instead).
function makeNoOpWaitStrategy(defaultTimeoutMs: number): WaitStrategy {
  let storedTimeoutMs: number | undefined;
  const strategy: WaitStrategy = {
    async waitUntilReady() {
      // Intentionally empty — readiness is determined by the SQL probe below.
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

const POSTGRES_IMAGE = "pgvector/pgvector:pg16";

/** A fixture Agent call on a parent turn. */
interface CallFixture {
  toolUseId: string | null;
  child: string | null;
}

function options(overrides: Partial<SweepOptions> = {}): SweepOptions {
  return { execute: true, limit: null, baseline: 100, ...overrides };
}

if (process.env.RUN_INTEGRATION_TESTS && process.env.RUN_TESTCONTAINER_TESTS) {
  process.stdout.write(`[clear-ambiguous-spawn-links/testcontainer] starting ${POSTGRES_IMAGE}\n`);

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

  // SQL-level readiness probe (see sibling testcontainer files for rationale).
  // eslint-disable-next-line custom/no-real-fs-in-tests -- Date.now() used for a timing deadline, not path creation
  const probeDeadline = Date.now() + 60_000;
  let probeReady = false;
  // eslint-disable-next-line custom/no-real-fs-in-tests -- same false positive: a deadline comparison, not path construction
  while (Date.now() < probeDeadline) {
    try {
      const probe = postgres(connectionString, { max: 1, prepare: false, connect_timeout: 2 });
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
      `[clear-ambiguous-spawn-links/testcontainer] readiness probe timed out at ${host}:${port}`
    );
  }

  const sql = postgres(connectionString, { prepare: false, max: 5 });
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;

  const migrationsFolder = resolvePgMigrationsFolder();
  // eslint-disable-next-line custom/no-real-fs-in-tests -- reads the real committed migration journal, mirroring production's own bootstrap path
  const journalRaw = readFileSync(join(migrationsFolder, "meta", "_journal.json"), {
    encoding: "utf8",
  }) as string;
  const journal = JSON.parse(journalRaw) as Journal;
  const bootstrapResult = await bootstrapFreshPostgres(sql, migrationsFolder, journal);
  if (!bootstrapResult) {
    await container.stop().catch(() => {});
    throw new Error(
      `[clear-ambiguous-spawn-links/testcontainer] no bootstrap snapshot at ${migrationsFolder}/bootstrap`
    );
  }
  const db = drizzle(sql);
  await migrate(db, { migrationsFolder });

  process.stdout.write(
    `[clear-ambiguous-spawn-links/testcontainer] ready at ${host}:${port}, ` +
      `bootstrapped through ${bootstrapResult.throughTag}\n`
  );

  /** Seed one parent turn's worth of Agent calls. */
  async function seedTurn(
    sessionId: string,
    turnIndex: number,
    calls: CallFixture[]
  ): Promise<void> {
    await sql`
      INSERT INTO agent_transcripts (agent_session_id, harness)
      VALUES (${sessionId}, 'claude-code')
      ON CONFLICT (agent_session_id) DO NOTHING
    `;
    for (const call of calls) {
      await sql`
        INSERT INTO agent_spawns
          (parent_agent_session_id, parent_turn_index, parent_tool_use_id,
           child_agent_session_id, spawn_type, spawned_at)
        VALUES (${sessionId}, ${turnIndex}, ${call.toolUseId}, ${call.child},
                'foreground', now())
      `;
    }
  }

  async function childOf(
    sessionId: string,
    turnIndex: number,
    toolUseId: string
  ): Promise<string | null> {
    const rows = await sql<{ child_agent_session_id: string | null }[]>`
      SELECT child_agent_session_id FROM agent_spawns
      WHERE parent_agent_session_id = ${sessionId}
        AND parent_turn_index = ${turnIndex}
        AND parent_tool_use_id = ${toolUseId}
    `;
    return rows[0]?.child_agent_session_id ?? null;
  }

  try {
    describe("clear-ambiguous-spawn-links sweep [testcontainer, real Postgres]", () => {
      afterAll(async () => {
        process.stdout.write(`[clear-ambiguous-spawn-links/testcontainer] stopping container\n`);
        await sql.end().catch(() => {});
        await container.stop();
      });

      beforeEach(async () => {
        await sql`DELETE FROM agent_spawns`;
        await sql`DELETE FROM agent_transcripts`;
      });

      test("AT1: a NULL-parent_tool_use_id row on a multi-spawn turn is selected, cleared, and counted", async () => {
        // The prod survivor shape: two calls on one turn, one still resolved,
        // and its tool_use_id is NULL (a pre-mt#3692 row).
        await seedTurn("sess-at1", 7, [
          { toolUseId: null, child: "child-wrong" },
          { toolUseId: null, child: null },
        ]);

        // NEGATIVE CONTROL — the keying the shipped script used. `= NULL` is
        // never true, so this matches zero rows and the row survives untouched.
        const beforeFix = await sql`
          UPDATE agent_spawns SET child_agent_session_id = NULL
          WHERE parent_agent_session_id = 'sess-at1' AND parent_tool_use_id = ${null}
          RETURNING 1
        `;
        expect(beforeFix.length).toBe(0);
        const survived = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM agent_spawns
          WHERE parent_agent_session_id = 'sess-at1' AND child_agent_session_id IS NOT NULL
        `;
        expect(survived[0]?.n).toBe(1);

        // The corrected sweep selects it, clears it, and counts what it cleared.
        const targets = await selectSweepTargets(db as never, null);
        expect(targets.length).toBe(1);
        expect(targets[0]?.parent_tool_use_id).toBeNull();

        const cleared = await clearSweepTargets(db as never, null);
        expect(cleared.length).toBe(1);
        expect(cleared[0]?.cleared_child_agent_session_id).toBe("child-wrong");
        expect(cleared[0]?.parent_tool_use_id).toBeNull();

        expect((await countOutstanding(db as never)).rows).toBe(0);
      });

      test("AT2: zero rows cleared against a non-empty target set is a non-zero exit", () => {
        const outcome = {
          abort: null,
          targets: [
            {
              parent_agent_session_id: "s",
              parent_turn_index: 1,
              parent_tool_use_id: null,
              child_agent_session_id: "c",
            },
          ],
          matchedTurns: 1,
          cleared: [],
          outstanding: { rows: 1, turns: 1 },
        };
        expect(exitCodeFor(outcome, options())).toBe(1);
        // …and a clean full run is zero.
        expect(
          exitCodeFor(
            {
              abort: null,
              targets: [],
              matchedTurns: 0,
              cleared: [],
              outstanding: { rows: 0, turns: 0 },
            },
            options()
          )
        ).toBe(0);
      });

      test("AT3: after a --limit 1 run on a two-row turn, the stranded sibling stays visible", async () => {
        await seedTurn("sess-at3", 48, [
          { toolUseId: "toolu_a", child: "child-shared" },
          { toolUseId: "toolu_b", child: "child-shared" },
        ]);

        const cleared = await clearSweepTargets(db as never, 1);
        expect(cleared.length).toBe(1);

        // The shipped verification (`count(child) > 1`) sees nothing here — the
        // turn now has one resolved row. The corrected one still reports it.
        const outstanding = await countOutstanding(db as never);
        expect(outstanding.rows).toBe(1);
        expect(outstanding.turns).toBe(1);

        const stillSelectable = await selectSweepTargets(db as never, null);
        expect(stillSelectable.length).toBe(1);
      });

      test("AT4: NULL-key rows outside the target set are untouched (the IS NOT DISTINCT FROM over-match)", async () => {
        // Same parent session, two turns. Only the multi-spawn turn is a target;
        // the single-call turn's NULL-key row must survive. Keying the UPDATE on
        // (session, tool_use_id) with IS NOT DISTINCT FROM would clear both.
        await seedTurn("sess-at4", 1, [
          { toolUseId: null, child: "child-wrong" },
          { toolUseId: null, child: null },
        ]);
        await seedTurn("sess-at4", 2, [{ toolUseId: null, child: "child-legit" }]);

        const targets = await selectSweepTargets(db as never, null);
        expect(targets.length).toBe(1);
        expect(targets[0]?.parent_turn_index).toBe(1);

        const cleared = await clearSweepTargets(db as never, null);
        expect(cleared.length).toBe(1);

        const bystander = await sql<{ child_agent_session_id: string | null }[]>`
          SELECT child_agent_session_id FROM agent_spawns
          WHERE parent_agent_session_id = 'sess-at4' AND parent_turn_index = 2
        `;
        expect(bystander[0]?.child_agent_session_id).toBe("child-legit");
      });

      test("AT5: a turn resolving siblings to DISTINCT children aborts the sweep and clears nothing", async () => {
        await seedTurn("sess-at5", 3, [
          { toolUseId: "toolu_x", child: "child-one" },
          { toolUseId: "toolu_y", child: "child-two" },
        ]);

        expect(await countDistinctChildTurns(db as never)).toBe(1);

        const outcome = await runSweep(db as never, options());
        expect(outcome.abort).toContain("DISTINCT children");
        expect(outcome.cleared).toBeNull();
        expect(exitCodeFor(outcome, options())).toBe(1);

        expect(await childOf("sess-at5", 3, "toolu_x")).toBe("child-one");
        expect(await childOf("sess-at5", 3, "toolu_y")).toBe("child-two");
      });

      test("AT7: a second full run clears nothing and reports zero outstanding", async () => {
        await seedTurn("sess-at7", 9, [
          { toolUseId: null, child: "child-wrong" },
          { toolUseId: "toolu_z", child: null },
        ]);

        const first = await runSweep(db as never, options());
        expect(first.abort).toBeNull();
        expect(first.cleared?.length).toBe(1);
        expect(first.outstanding?.rows).toBe(0);
        expect(exitCodeFor(first, options())).toBe(0);

        const second = await runSweep(db as never, options());
        expect(second.abort).toBeNull();
        expect(second.targets.length).toBe(0);
        expect(second.cleared?.length).toBe(0);
        expect(second.outstanding?.rows).toBe(0);
        expect(exitCodeFor(second, options())).toBe(0);
      });

      test("the scope-match guard aborts when the population outruns the stated baseline", async () => {
        await seedTurn("sess-scope-a", 1, [
          { toolUseId: null, child: "child-a" },
          { toolUseId: null, child: null },
        ]);
        await seedTurn("sess-scope-b", 1, [
          { toolUseId: null, child: "child-b" },
          { toolUseId: null, child: null },
        ]);
        await seedTurn("sess-scope-c", 1, [
          { toolUseId: null, child: "child-c" },
          { toolUseId: null, child: null },
        ]);

        const outcome = await runSweep(db as never, options({ baseline: 1 }));
        expect(outcome.abort).toContain("divergence");
        expect(outcome.cleared).toBeNull();

        // Nothing was written.
        const remaining = await db.execute(drizzleSql`
          SELECT count(*)::int AS n FROM agent_spawns WHERE child_agent_session_id IS NOT NULL
        `);
        expect(Array.from(remaining as Iterable<{ n: number }>)[0]?.n).toBe(3);
      });

      test("a dry-run reports the population and writes nothing", async () => {
        await seedTurn("sess-dry", 4, [
          { toolUseId: null, child: "child-dry" },
          { toolUseId: "toolu_dry", child: null },
        ]);

        const outcome = await runSweep(db as never, options({ execute: false }));
        expect(outcome.targets.length).toBe(1);
        expect(outcome.cleared).toBeNull();
        expect(exitCodeFor(outcome, options({ execute: false }))).toBe(0);

        const untouched = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM agent_spawns WHERE child_agent_session_id IS NOT NULL
        `;
        expect(untouched[0]?.n).toBe(1);
      });
    });
  } catch (err) {
    await sql.end().catch(() => {});
    await container.stop().catch(() => {});
    throw err;
  }
} else {
  const missing: string[] = [];
  if (!process.env.RUN_INTEGRATION_TESTS) missing.push("RUN_INTEGRATION_TESTS=1");
  if (!process.env.RUN_TESTCONTAINER_TESTS) missing.push("RUN_TESTCONTAINER_TESTS=1");
  process.stdout.write(
    `[clear-ambiguous-spawn-links/testcontainer] skipped — set ${missing.join(", ")} to run\n`
  );
}

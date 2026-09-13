/**
 * mt#5131 — remainder disposition against a real Postgres (testcontainer).
 *
 * The live exercise for the store: park (status, tag, spec append, CAS on the
 * status the plan saw), resurrect, idempotence, the zero-pointings guard, and
 * the `pointings.declare` seam that resurrects in the same call (AT3). The
 * `system_events` table is deliberately absent: emission is best-effort and
 * swallowed, and these tests assert the rows, not the ledger.
 *
 * Gated like its siblings: RUN_INTEGRATION_TESTS=1 RUN_TESTCONTAINER_TESTS=1.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { GenericContainer, type WaitStrategy } from "testcontainers";
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { archivePointing, declarePointing } from "../../packages/domain/src/tasks/pointings-store";
import { runRemainderSweep } from "../../packages/domain/src/tasks/remainder-expiry-store";
import { AUTO_EXPIRED_TAG } from "../../packages/domain/src/tasks/remainder-expiry";
import { createTasksPointingsDeclareCommand } from "../../src/adapters/shared/commands/tasks/pointing-commands";

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
const PROJECT_ID = "3ac3d147-2b6f-4cf9-a52a-2b6e32d3c5fe";

const DDL = `
  create extension if not exists pgcrypto;
  create table projects (id uuid primary key default gen_random_uuid());
  create table tasks (
    id text primary key,
    status text,
    title text,
    tags text default '[]',
    kind text default 'implementation' not null,
    created_at timestamp with time zone default now(),
    updated_at timestamp with time zone default now(),
    project_id uuid references projects(id)
  );
  create table task_specs (
    task_id text primary key,
    content text not null,
    updated_at timestamp with time zone default now()
  );
  create table task_relationships (
    id uuid primary key default gen_random_uuid(),
    from_task_id text not null,
    to_task_id text not null,
    type text not null default 'depends'
  );
  CREATE TABLE "pointings" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "name" text NOT NULL,
    "query" jsonb NOT NULL,
    "autonomy_class" text DEFAULT 'pull-only' NOT NULL,
    "wip_limit" integer DEFAULT 1 NOT NULL,
    "project_id" uuid,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "archived_at" timestamp with time zone
  );
`;

if (process.env.RUN_INTEGRATION_TESTS && process.env.RUN_TESTCONTAINER_TESTS) {
  process.stdout.write(`[mt5131/testcontainer] starting ${POSTGRES_IMAGE}\n`);

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
    throw new Error(`[mt5131/testcontainer] readiness probe timed out at ${host}:${port}`);
  }
  process.stdout.write(`[mt5131/testcontainer] ready at ${host}:${port}\n`);

  const sql = postgres(connectionString, { max: 5, prepare: false });
  const db = drizzle(sql) as PostgresJsDatabase;
  await sql.unsafe(DDL);

  // ── Fixture (AT1's shape) ─────────────────────────────────────────────────
  // A fixed clock; every age is anchored to it, never to the real clock.
  const NOW_MS = Date.UTC(2026, 8, 13, 11, 0, 0);
  const daysAgo = (n: number) => new Date(NOW_MS - n * 86_400_000).toISOString();
  await sql`insert into projects (id) values (${PROJECT_ID})`;
  const seed = [
    ["mt#1", "TODO", "Fresh", "[]", "implementation", daysAgo(3)],
    ["mt#2", "TODO", "Fresh hooks", '["hooks"]', "implementation", daysAgo(20)],
    ["mt#3", "TODO", "Stale, pointed", '["hooks"]', "implementation", daysAgo(120)],
    ["mt#4", "READY", "Stale, pointed via parent", "[]", "implementation", daysAgo(150)],
    ["mt#5", "TODO", "Stale, unpointed", "[]", "implementation", daysAgo(200)],
    ["mt#6", "BLOCKED", "Stale, unpointed, blocked", '["misc"]', "implementation", daysAgo(95)],
    [
      "mt#7",
      "CLOSED",
      "Parked, now pointed",
      `["${AUTO_EXPIRED_TAG}","hooks"]`,
      "implementation",
      daysAgo(10),
    ],
    ["mt#8", "IN-PROGRESS", "Stale but owned", "[]", "implementation", daysAgo(300)],
    ["mt#9", "READY", "Stale package", "[]", "work-package", daysAgo(300)],
    ["mt#10", "CLOSED", "Hand-closed, pointed", '["hooks"]', "implementation", daysAgo(300)],
    [
      "mt#11",
      "CLOSED",
      "Parked, still unpointed",
      `["${AUTO_EXPIRED_TAG}"]`,
      "implementation",
      daysAgo(10),
    ],
    ["mt#12", "TODO", "Stale umbrella", "[]", "umbrella", daysAgo(300)],
  ] as const;
  for (const [id, status, title, tags, kind, updated] of seed) {
    await sql`insert into tasks (id, status, title, tags, kind, project_id, updated_at)
      values (${id}, ${status}, ${title}, ${tags}, ${kind}, ${PROJECT_ID}, ${updated})`;
    await sql`insert into task_specs (task_id, content) values (${id}, ${`## Summary\n\n${title}.`})`;
  }
  // mt#4 sits under mt#3 — the parent-subtree pointing reaches it.
  await sql`insert into task_relationships (from_task_id, to_task_id, type) values ('mt#4', 'mt#3', 'parent')`;

  const tagsOf = async (id: string): Promise<string[]> => {
    const [r] = await sql`select tags from tasks where id = ${id}`;
    return JSON.parse((r?.tags as string) ?? "[]") as string[];
  };
  const statusOf = async (id: string): Promise<string> => {
    const [r] = await sql`select status from tasks where id = ${id}`;
    return String(r?.status);
  };
  const specOf = async (id: string): Promise<string> => {
    const [r] = await sql`select content from task_specs where task_id = ${id}`;
    return String(r?.content);
  };

  describe("mt#5131 — remainder disposition against a real Postgres", () => {
    afterAll(async () => {
      await sql.end().catch(() => {});
      await container.stop().catch(() => {});
    });

    test("with zero live pointings: the dry-run names what would park, parks nothing, resurrects nothing", async () => {
      const out = await runRemainderSweep(db, {
        projectScope: PROJECT_ID,
        execute: true,
        nowMs: NOW_MS,
        via: "test",
      });
      expect(out.dryRun).toBe(false);
      expect(out.plan.parkingSuspended).toBe("no live pointings");
      expect(out.plan.wouldPark.sort()).toEqual(["mt#3", "mt#4", "mt#5", "mt#6"]);
      expect(out.plan.park).toEqual([]);
      expect(out.applied).toEqual({ parked: [], resurrected: [] });
      expect(await statusOf("mt#5")).toBe("TODO");
    });

    test("AT1: dry-run reports park {mt#5, mt#6} and resurrect {mt#7}; execute produces exactly that; a second run is 0 / 0", async () => {
      const declared = await declarePointing(db, {
        name: "hooks",
        query: { tags: ["hooks"], parentIds: ["mt#3"] },
        projectScope: PROJECT_ID,
      });
      if (!declared.ok) throw new Error(declared.message);

      const dry = await runRemainderSweep(db, {
        projectScope: PROJECT_ID,
        nowMs: NOW_MS,
        via: "test",
      });
      expect(dry.dryRun).toBe(true);
      expect(dry.plan.park).toEqual(["mt#5", "mt#6"]); // oldest first: 200d, 95d
      expect(dry.plan.resurrect.map((r) => r.id)).toEqual(["mt#7"]);
      expect(dry.applied).toEqual({ parked: [], resurrected: [] });
      // AT2: the stale IN-PROGRESS task, the stale package and the stale umbrella are not candidates.
      expect(dry.plan.wouldPark).not.toContain("mt#8");
      expect(dry.plan.wouldPark).not.toContain("mt#9");
      expect(dry.plan.wouldPark).not.toContain("mt#12");
      // A hand-closed task a pointing matches is not resurrected — only ours.
      expect(dry.plan.resurrect.map((r) => r.id)).not.toContain("mt#10");

      const run = await runRemainderSweep(db, {
        projectScope: PROJECT_ID,
        execute: true,
        nowMs: NOW_MS,
        via: "test",
      });
      expect(run.applied.parked).toEqual(["mt#5", "mt#6"]);
      expect(run.applied.resurrected).toEqual(["mt#7"]);

      expect(await statusOf("mt#5")).toBe("CLOSED");
      expect(await tagsOf("mt#5")).toEqual([AUTO_EXPIRED_TAG]);
      expect(await tagsOf("mt#6")).toEqual(["misc", AUTO_EXPIRED_TAG]);
      const parkedSpec = await specOf("mt#5");
      expect(parkedSpec).toContain("## Auto-expired (2026-09-13)");
      expect(parkedSpec).toContain(`Pointings checked: ${declared.pointing.id}`);

      expect(await statusOf("mt#7")).toBe("TODO");
      expect(await tagsOf("mt#7")).toEqual(["hooks"]);
      expect(await specOf("mt#7")).toContain(
        `## Resurrected (2026-09-13) by pointing ${declared.pointing.id}`
      );
      // Untouched: pointed stale tasks, fresh tasks, the hand-closed one, the still-unpointed parked one.
      expect(await statusOf("mt#3")).toBe("TODO");
      expect(await statusOf("mt#4")).toBe("READY");
      expect(await statusOf("mt#10")).toBe("CLOSED");
      expect(await statusOf("mt#11")).toBe("CLOSED");

      const again = await runRemainderSweep(db, {
        projectScope: PROJECT_ID,
        execute: true,
        nowMs: NOW_MS,
        via: "test",
      });
      expect(again.plan.park).toEqual([]);
      expect(again.plan.resurrect).toEqual([]);
      expect(again.applied).toEqual({ parked: [], resurrected: [] });

      await archivePointing(db, declared.pointing.id, new Date(NOW_MS));
    });

    test("AT3: pointings.declare with a query matching a parked task resurrects it in the same call", async () => {
      // mt#5 was parked above with no pointing over it; mt#11 was parked before the fixture.
      const command = createTasksPointingsDeclareCommand(() => ({
        getDatabaseConnection: async () => db,
      }));
      const result = (await command.execute(
        { name: "everything-stale", taskIds: "mt#5,mt#11" } as never,
        {} as never
      )) as {
        success: boolean;
        resurrected?: string[];
        pointing?: { id: string };
      };
      expect(result.success).toBe(true);
      expect((result.resurrected ?? []).sort()).toEqual(["mt#11", "mt#5"]);
      expect(await statusOf("mt#5")).toBe("TODO");
      expect(await tagsOf("mt#5")).toEqual([]);
      expect(await specOf("mt#5")).toContain(`by pointing ${result.pointing?.id}`);
      expect(await statusOf("mt#11")).toBe("TODO");
    });

    test("the cap bounds a run's parks and reports it", async () => {
      // Make two more stale unpointed rows, then park with cap 1.
      await sql`insert into tasks (id, status, title, tags, kind, project_id, updated_at)
        values ('mt#20', 'TODO', 'Stale A', '[]', 'implementation', ${PROJECT_ID}, ${daysAgo(400)}),
               ('mt#21', 'TODO', 'Stale B', '[]', 'implementation', ${PROJECT_ID}, ${daysAgo(300)})`;
      await sql`insert into task_specs (task_id, content) values ('mt#20', '## Summary'), ('mt#21', '## Summary')`;
      const declared = await declarePointing(db, {
        name: "cap-probe",
        query: { tags: ["hooks"] },
        projectScope: PROJECT_ID,
      });
      if (!declared.ok) throw new Error(declared.message);
      const run = await runRemainderSweep(db, {
        projectScope: PROJECT_ID,
        execute: true,
        nowMs: NOW_MS,
        cap: 1,
        via: "test",
      });
      expect(run.plan.capped).toBe(true);
      expect(run.applied.parked).toEqual(["mt#20"]);
      expect(await statusOf("mt#21")).toBe("TODO");
    });
  });
}

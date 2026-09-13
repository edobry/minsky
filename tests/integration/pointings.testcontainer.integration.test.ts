/**
 * mt#5129 — standing pointings against a real Postgres (testcontainer).
 *
 * The live exercise for the pointings store: the `pointings` DDL below is the
 * statement set migration `0118_tranquil_shape.sql` emits (copied, with the
 * same IF NOT EXISTS guards), applied to a fresh postgres:16-alpine alongside
 * the minimal `tasks` / `task_specs` / `task_relationships` / `projects`
 * shapes the store reads. Declare → list → candidates → archive run end to end
 * so the migration SQL, the drizzle schema, and the read path are exercised
 * together before anything reaches production — the migration is applied there
 * by the deploy, never by hand.
 *
 * Gated like its siblings: RUN_INTEGRATION_TESTS=1 RUN_TESTCONTAINER_TESTS=1.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { GenericContainer, type WaitStrategy } from "testcontainers";
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  archivePointing,
  computeCandidateSet,
  declarePointing,
  evaluatePointingQuery,
  listPointings,
} from "../../packages/domain/src/tasks/pointings-store";

/** No-op wait strategy — the built-in ones hang under Bun; readiness is the SQL probe below. */
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
  create table task_specs (task_id text primary key, content text not null);
  create table task_relationships (
    id uuid primary key default gen_random_uuid(),
    from_task_id text not null,
    to_task_id text not null,
    type text not null default 'depends'
  );
  -- 0118_tranquil_shape.sql, verbatim apart from the statement-breakpoint markers.
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
  ALTER TABLE "pointings" ADD CONSTRAINT "pointings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
  CREATE INDEX IF NOT EXISTS "pointings_project_id_idx" ON "pointings" USING btree ("project_id");
  CREATE UNIQUE INDEX IF NOT EXISTS "pointings_project_name_live_idx" ON "pointings" USING btree ("project_id","name") WHERE archived_at IS NULL;
`;

if (process.env.RUN_INTEGRATION_TESTS && process.env.RUN_TESTCONTAINER_TESTS) {
  process.stdout.write(`[mt5129/testcontainer] starting ${POSTGRES_IMAGE}\n`);

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
    throw new Error(`[mt5129/testcontainer] readiness probe timed out at ${host}:${port}`);
  }
  process.stdout.write(`[mt5129/testcontainer] ready at ${host}:${port}\n`);

  const sql = postgres(connectionString, { max: 5, prepare: false });
  const db = drizzle(sql) as PostgresJsDatabase;
  await sql.unsafe(DDL);

  // ── Fixture ────────────────────────────────────────────────────────────────
  // mt#1 TODO cockpit; mt#2 TODO, child of mt#1; mt#3 TODO incident, depends on
  // mt#4 (DONE) and mt#5 (TODO); mt#6 is a work package; mt#7 is BLOCKED;
  // mt#8 depends on mt#1 (so mt#1 unblocks one open task); mt#b0..b24 bulk.
  // A fixed clock: the candidate set takes `nowMs`, so age arithmetic is anchored, not live.
  const NOW_MS = Date.UTC(2026, 8, 13, 9, 0, 0);
  const twelveDaysAgo = new Date(NOW_MS - 12 * 86_400_000).toISOString();
  const recently = new Date(NOW_MS - 3 * 86_400_000).toISOString();
  await sql`insert into projects (id) values (${PROJECT_ID})`;
  const seed = [
    ["mt#1", "TODO", "Cockpit widget", '["cockpit"]', "implementation", twelveDaysAgo],
    ["mt#2", "TODO", "Cockpit child", "[]", "implementation", null],
    ["mt#3", "TODO", "Incident follow-up", '["incident"]', "implementation", null],
    ["mt#4", "DONE", "Done dep", "[]", "implementation", null],
    ["mt#5", "TODO", "Open dep", "[]", "implementation", null],
    ["mt#6", "READY", "A package", '["cockpit"]', "work-package", null],
    ["mt#7", "BLOCKED", "Blocked cockpit", '["cockpit"]', "implementation", null],
    ["mt#8", "TODO", "Depends on mt#1", "[]", "implementation", null],
  ] as const;
  for (const [id, status, title, tags, kind, updated] of seed) {
    await sql`insert into tasks (id, status, title, tags, kind, project_id, updated_at)
      values (${id}, ${status}, ${title}, ${tags}, ${kind}, ${PROJECT_ID}, ${updated ?? recently})`;
  }
  for (let i = 0; i < 25; i++) {
    await sql`insert into tasks (id, status, title, tags, kind, project_id)
      values (${`mt#b${i}`}, 'TODO', ${`Bulk ${i}`}, '["bulk"]', 'implementation', ${PROJECT_ID})`;
  }
  await sql`insert into task_specs (task_id, content) values ('mt#2', 'Origin: incident — a live cockpit defect')`;
  await sql`insert into task_relationships (from_task_id, to_task_id, type) values
    ('mt#2', 'mt#1', 'parent'),
    ('mt#3', 'mt#4', 'depends'),
    ('mt#3', 'mt#5', 'depends'),
    ('mt#8', 'mt#1', 'depends')`;

  describe("mt#5129 — pointings against a real Postgres", () => {
    afterAll(async () => {
      await sql.end().catch(() => {});
      await container.stop().catch(() => {});
    });

    test("AT4: an empty query is refused and nothing is written", async () => {
      const out = await declarePointing(db, { name: "empty", query: {}, projectScope: PROJECT_ID });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe("empty-query");
      expect(await listPointings(db, { projectScope: PROJECT_ID })).toHaveLength(0);
    });

    test("AT2/AT3: a union query yields the right members with the four flags; packages and BLOCKED are excluded", async () => {
      const declared = await declarePointing(db, {
        name: "cockpit",
        query: { tags: ["cockpit"], parentIds: ["mt#1"], taskIds: ["mt#3"] },
        projectScope: PROJECT_ID,
      });
      expect(declared.ok).toBe(true);
      if (!declared.ok) return;

      const set = await computeCandidateSet(db, declared.pointing, { seed: 3, nowMs: NOW_MS });
      expect(set.ordering).toBe("arbitrary");
      expect(set.matched).toBe(3);
      expect(set.truncated).toBe(false);
      expect(set.items.map((i) => i.id).sort()).toEqual(["mt#1", "mt#2", "mt#3"]);

      const byId = new Map(set.items.map((i) => [i.id, i]));
      expect(byId.get("mt#3")?.readiness).toBe(0.5); // one of two deps terminal
      expect(byId.get("mt#3")?.incidentLineage).toBe(true); // tag
      expect(byId.get("mt#2")?.incidentLineage).toBe(true); // Origin line in its spec
      expect(byId.get("mt#1")?.unblockCount).toBe(1); // mt#8 depends on it and is open
      expect(byId.get("mt#1")?.daysSinceTouched).toBe(12);
      expect(byId.get("mt#1")?.readiness).toBe(1);

      // The evaluator the remainder sweep consumes agrees with the candidate set.
      const ids = await evaluatePointingQuery(db, declared.pointing.query, PROJECT_ID);
      expect(ids.sort()).toEqual(["mt#1", "mt#2", "mt#3"]);
    });

    test("AT1: a 25-match query returns 10, truncated, matched 25, in a seed-dependent order", async () => {
      const declared = await declarePointing(db, {
        name: "bulk",
        query: { tags: ["bulk"] },
        projectScope: PROJECT_ID,
        wipLimit: 3,
        autonomyClass: "contained",
      });
      expect(declared.ok).toBe(true);
      if (!declared.ok) return;
      const a = await computeCandidateSet(db, declared.pointing, { seed: 1 });
      const b = await computeCandidateSet(db, declared.pointing, { seed: 2 });
      expect(a.items).toHaveLength(10);
      expect(a.matched).toBe(25);
      expect(a.truncated).toBe(true);
      expect(a.pointing).toEqual({
        id: declared.pointing.id,
        name: "bulk",
        autonomyClass: "contained",
        wipLimit: 3,
      });
      expect(a.items.map((i) => i.id)).not.toEqual(b.items.map((i) => i.id));
    });

    test("AT4: a live name is taken; archive sets archivedAt and list hides it by default", async () => {
      const dup = await declarePointing(db, {
        name: "bulk",
        query: { tags: ["x"] },
        projectScope: PROJECT_ID,
      });
      expect(dup.ok).toBe(false);
      if (!dup.ok) expect(dup.reason).toBe("name-taken");

      const live = await listPointings(db, { projectScope: PROJECT_ID });
      expect(live.map((p) => p.name).sort()).toEqual(["bulk", "cockpit"]);

      const bulk = live.find((p) => p.name === "bulk");
      expect(bulk).toBeDefined();
      if (!bulk) return;
      const archived = await archivePointing(db, bulk.id, new Date("2026-09-13T09:00:00Z"));
      expect(archived.ok).toBe(true);
      if (archived.ok)
        expect(archived.pointing.archivedAt?.toISOString()).toBe("2026-09-13T09:00:00.000Z");

      expect((await listPointings(db, { projectScope: PROJECT_ID })).map((p) => p.name)).toEqual([
        "cockpit",
      ]);
      expect(
        (await listPointings(db, { projectScope: PROJECT_ID, includeArchived: true }))
          .map((p) => p.name)
          .sort()
      ).toEqual(["bulk", "cockpit"]);

      const again = await archivePointing(db, bulk.id);
      expect(again.ok).toBe(false);

      // The name is free again once the old row is archived.
      const redeclared = await declarePointing(db, {
        name: "bulk",
        query: { tags: ["x"] },
        projectScope: PROJECT_ID,
      });
      expect(redeclared.ok).toBe(true);
    });
  });
}

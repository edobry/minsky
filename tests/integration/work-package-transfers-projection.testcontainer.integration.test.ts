/**
 * mt#5143 — the `## Transfers` projection against a real Postgres (testcontainer).
 *
 * Every transfer writer re-renders the spec section after its commit: create
 * (`writeWorkPackageCreateRows`), release (`releaseWorkPackage`), complete
 * (`completeWorkPackage`), and the sweep that calls the last two. AT1 covers
 * release and complete; AT2 makes the spec write FAIL (a CHECK constraint on
 * `task_specs.content`) and asserts the transfer row and the status change
 * survive it; AT3 is the one-shot: the dry-run classifies missing / behind /
 * in-sync, `--execute` renders every package with a log, a re-run plans zero.
 *
 * Gated like its siblings: RUN_INTEGRATION_TESTS=1 RUN_TESTCONTAINER_TESTS=1.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { GenericContainer, type WaitStrategy } from "testcontainers";
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  claimWorkPackage,
  releaseWorkPackage,
} from "../../packages/domain/src/tasks/work-package-claim";
import { completeWorkPackage } from "../../packages/domain/src/tasks/work-package-lifecycle";
import { writeWorkPackageCreateRows } from "../../packages/domain/src/tasks/work-package-store";
import { runWorkPackageLifecycleSweep } from "../../packages/domain/src/tasks/work-package-lifecycle-sweep";
import {
  countRenderedTransfers,
  runTransfersRefresh,
} from "../../packages/domain/src/tasks/work-package-transfers-projection";
import { createTasksPackagesRefreshTransfersCommand } from "../../src/adapters/shared/commands/tasks/work-package-lifecycle-commands";

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
const CONV_A = "com.anthropic.claude-code:conv:1d82ba6d-99e8-4d5e-bfb4-d8252aaaaaaa";
const WORK_PACKAGE = "work-package";
const TRANSFERS_HEADING = "## Transfers";

const DDL = `
  create extension if not exists pgcrypto;
  create table projects (id uuid primary key default gen_random_uuid());
  create table tasks (
    id text primary key,
    status text,
    title text,
    tags text default '[]',
    kind text default 'implementation' not null,
    claimed_by text,
    claimed_at timestamp with time zone,
    created_at timestamp with time zone default now(),
    updated_at timestamp with time zone default now(),
    project_id uuid references projects(id)
  );
  create table task_specs (
    task_id text primary key,
    content text not null,
    version integer default 1,
    created_at timestamp with time zone default now(),
    updated_at timestamp with time zone default now()
  );
  create table work_package_members (
    package_task_id text not null,
    member_task_id text not null,
    rank integer not null,
    status_at_write text,
    rationale text,
    created_at timestamp with time zone default now(),
    primary key (package_task_id, member_task_id)
  );
  create table work_package_transfers (
    package_task_id text not null,
    seq integer not null,
    origin text not null,
    by_conversation text,
    notes text,
    created_at timestamp with time zone default now(),
    primary key (package_task_id, seq)
  );
  create table presence_claims (
    id uuid primary key default gen_random_uuid(),
    subject_kind text not null,
    subject_id text not null,
    actor_id text not null,
    cc_conversation_id text,
    tty text,
    host text,
    session_id text,
    project_id uuid,
    pid integer,
    entrypoint text,
    terminal_context jsonb,
    claimed_at timestamp with time zone default now() not null,
    last_refreshed_at timestamp with time zone default now() not null
  );
  create type system_event_type as enum ('task.status_changed');
  create table system_events (
    id uuid primary key default gen_random_uuid(),
    event_type system_event_type not null,
    payload jsonb not null,
    actor text,
    related_task_id text,
    related_session_id text,
    created_at timestamp with time zone default now() not null
  );
`;

const BRIEFING = `# A bundle

Origin: groomed

## Members

1. mt#1 — first
2. mt#2 — second

## Grouping rationale

Same widget.
`;

if (process.env.RUN_INTEGRATION_TESTS && process.env.RUN_TESTCONTAINER_TESTS) {
  process.stdout.write(`[mt5143/testcontainer] starting ${POSTGRES_IMAGE}\n`);

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
  if (!ready) throw new Error("postgres testcontainer never became ready");
  process.stdout.write(`[mt5143/testcontainer] ready at ${host}:${port}\n`);

  const sql = postgres(connectionString, { max: 5, prepare: false });
  const db = drizzle(sql) as PostgresJsDatabase;
  await sql.unsafe(DDL);

  // ── Fixture ─────────────────────────────────────────────────────────────────
  const NOW = new Date(Date.UTC(2026, 8, 14, 12, 0, 0));
  await sql`insert into projects (id) values (${PROJECT_ID})`;
  const task = async (id: string, status: string) => {
    await sql`insert into tasks (id, status, title, kind, project_id) values (${id}, ${status}, ${id}, 'implementation', ${PROJECT_ID})`;
  };
  /** A package row + spec, WITHOUT going through the create writer (pre-mt#5143 shape). */
  const legacyPkg = async (
    id: string,
    status: string,
    members: string[],
    transfers: number,
    claimedBy: string | null = null
  ) => {
    await sql`insert into tasks (id, status, title, kind, project_id, claimed_by, claimed_at)
      values (${id}, ${status}, ${id}, ${WORK_PACKAGE}, ${PROJECT_ID}, ${claimedBy}, ${claimedBy ? NOW.toISOString() : null})`;
    await sql`insert into task_specs (task_id, content) values (${id}, ${BRIEFING})`;
    for (const [i, m] of members.entries()) {
      await sql`insert into work_package_members (package_task_id, member_task_id, rank) values (${id}, ${m}, ${i + 1})`;
    }
    for (let seq = 1; seq <= transfers; seq += 1) {
      await sql`insert into work_package_transfers (package_task_id, seq, origin, notes) values (${id}, ${seq}, ${seq === 1 ? "groomed" : "release"}, ${`t${seq}`})`;
    }
  };

  await task("mt#1", "DONE");
  await task("mt#2", "READY");
  await task("mt#3", "DONE");
  await legacyPkg("mt#100", "IN-PROGRESS", ["mt#1", "mt#2"], 1, CONV_A); // AT1: release
  await legacyPkg("mt#101", "READY", ["mt#1", "mt#3"], 1); // AT1: complete (via the sweep)
  await legacyPkg("mt#102", "IN-PROGRESS", ["mt#1", "mt#2"], 1, CONV_A); // AT2: failing spec write
  await legacyPkg("mt#103", "READY", ["mt#2"], 2); // AT3: missing section, 2 transfers
  await legacyPkg("mt#104", "DONE", ["mt#1"], 3); // AT3: terminal, missing section
  await legacyPkg("mt#105", "CLOSED", [], 0); // AT3: no log at all → not in the plan
  await legacyPkg("mt#106", "READY", ["mt#1"], 1); // AT1: complete, called directly

  const specOf = async (id: string): Promise<string> => {
    const [r] = await sql`select content from task_specs where task_id = ${id}`;
    return String(r?.content ?? "");
  };
  const logCountOf = async (id: string): Promise<number> => {
    const [r] =
      await sql`select count(*)::int as n from work_package_transfers where package_task_id = ${id}`;
    return Number(r?.n);
  };
  const rowOf = async (id: string) => {
    const [r] = await sql`select status, claimed_by from tasks where id = ${id}`;
    return { status: String(r?.status), claimedBy: (r?.claimed_by as string | null) ?? null };
  };
  const sectionOf = async (id: string) =>
    (await specOf(id)).slice((await specOf(id)).indexOf(TRANSFERS_HEADING));

  describe("mt#5143 — `## Transfers` projection against a real Postgres", () => {
    afterAll(async () => {
      await sql.end().catch(() => {});
      await container.stop().catch(() => {});
    });

    test("AT1: create renders seq 1; release and complete each re-render after their commit", async () => {
      // create — through the real writer, onto a task row the create seam made first.
      await sql`insert into tasks (id, status, title, kind, project_id) values ('mt#110', 'TODO', 'mt#110', ${WORK_PACKAGE}, ${PROJECT_ID})`;
      await sql`insert into task_specs (task_id, content) values ('mt#110', ${BRIEFING})`;
      await writeWorkPackageCreateRows(
        db,
        {
          packageTaskId: "mt#110",
          origin: "groomed",
          members: [{ taskId: "mt#1", rank: 1, rationale: "first" }],
          byConversation: CONV_A,
        },
        NOW
      );
      expect(countRenderedTransfers(await specOf("mt#110"))).toBe(1);
      expect(await sectionOf("mt#110")).toContain(
        `- #1 groomed — ${NOW.toISOString()} — by ${CONV_A}`
      );
      // The briefing above the section is untouched.
      expect((await specOf("mt#110")).startsWith(BRIEFING.trimEnd())).toBe(true);

      // release — mt#100 had no section; after the release it lists both entries.
      expect(countRenderedTransfers(await specOf("mt#100"))).toBeNull();
      const release = await releaseWorkPackage(
        db,
        { taskId: "mt#100", byConversation: CONV_A, notes: "done for today" },
        NOW
      );
      expect(release.ok).toBe(true);
      expect(countRenderedTransfers(await specOf("mt#100"))).toBe(2);
      expect(await sectionOf("mt#100")).toContain("- #2 release — ");
      expect(await sectionOf("mt#100")).toContain("done for today");

      // complete — directly on mt#106, then via the sweep on mt#101 (members all terminal).
      const complete = await completeWorkPackage(
        db,
        { taskId: "mt#106", notes: "every member terminal" },
        NOW
      );
      expect(complete.ok).toBe(true);
      expect(countRenderedTransfers(await specOf("mt#106"))).toBe(2);
      expect(await sectionOf("mt#106")).toContain("- #2 completed — ");
      expect(await sectionOf("mt#106")).toContain("every member terminal");

      const sweep = await runWorkPackageLifecycleSweep(db, {
        execute: true,
        nowMs: NOW.getTime(),
        via: "test",
      });
      expect(sweep.applied.closed).toEqual(["mt#101"]);
      expect(await rowOf("mt#101")).toEqual({ status: "DONE", claimedBy: null });
      expect(countRenderedTransfers(await specOf("mt#101"))).toBe(2);
      expect(await sectionOf("mt#101")).toContain("- #2 completed — ");
    });

    test("AT2: a failing spec write leaves the transfer committed and the status changed", async () => {
      // Make every task_specs write for mt#102 fail: the projection is a
      // separate statement after the writer's commit, so this is the seam.
      // NOT VALID: the existing row is not checked, every later write to it is.
      await sql.unsafe(
        `alter table task_specs add constraint no_write_mt102 check (task_id <> 'mt#102' or length(content) < 10) not valid`
      );
      const before = await specOf("mt#102");
      const release = await releaseWorkPackage(
        db,
        { taskId: "mt#102", byConversation: CONV_A, notes: "constraint blocks the render" },
        NOW
      );
      expect(release.ok).toBe(true);
      if (!release.ok) throw new Error("unreachable");
      expect(release.transferSeq).toBe(2);
      expect(await logCountOf("mt#102")).toBe(2);
      expect(await rowOf("mt#102")).toEqual({ status: "READY", claimedBy: null });
      expect(await specOf("mt#102")).toBe(before);
      await sql.unsafe(`alter table task_specs drop constraint no_write_mt102`);

      // The one-shot then repairs exactly that package as `missing`.
      const dry = await runTransfersRefresh(db, { now: NOW });
      expect(dry.plan.refresh.find((e) => e.taskId === "mt#102")?.state).toBe("missing");
    });

    test("AT3: the one-shot plans missing/behind/in-sync, --execute renders every logged package, a re-run plans zero", async () => {
      // Put mt#100 one entry behind by hand, so all three states are present.
      await sql`insert into work_package_transfers (package_task_id, seq, origin) values ('mt#100', 3, 'release')`;

      const command = createTasksPackagesRefreshTransfersCommand(() => ({
        getDatabaseConnection: async () => db,
      }));
      const dry = (await command.execute({ execute: false } as never, {} as never)) as {
        dryRun: boolean;
        counts: Record<string, number>;
        refresh: Array<{
          taskId: string;
          state: string;
          logCount: number;
          rendered: number | null;
        }>;
      };
      expect(dry.dryRun).toBe(true);
      const byId = Object.fromEntries(dry.refresh.map((e) => [e.taskId, e]));
      expect(byId["mt#100"]).toMatchObject({ state: "behind", logCount: 3, rendered: 2 });
      expect(byId["mt#102"]).toMatchObject({ state: "missing", logCount: 2, rendered: null });
      expect(byId["mt#103"]).toMatchObject({ state: "missing", logCount: 2 });
      expect(byId["mt#104"]).toMatchObject({ state: "missing", logCount: 3 });
      expect(byId["mt#105"]).toBeUndefined(); // no log → not a projection target
      expect(dry.counts.inSync).toBe(3); // mt#101 (sweep complete), mt#106 (complete), mt#110 (create)
      expect(dry.counts.refresh).toBe(4);
      expect(dry.counts.refreshed).toBe(0);
      expect(countRenderedTransfers(await specOf("mt#103"))).toBeNull();

      const run = (await command.execute({ execute: true } as never, {} as never)) as {
        dryRun: boolean;
        counts: Record<string, number>;
        applied: { refreshed: string[]; failed: unknown[] };
      };
      expect(run.dryRun).toBe(false);
      expect(run.applied.refreshed.sort()).toEqual(["mt#100", "mt#102", "mt#103", "mt#104"]);
      expect(run.applied.failed).toEqual([]);
      for (const id of ["mt#100", "mt#101", "mt#102", "mt#103", "mt#104", "mt#106", "mt#110"]) {
        expect(countRenderedTransfers(await specOf(id))).toBe(await logCountOf(id));
      }
      // A terminal package's briefing is kept above its section.
      expect((await specOf("mt#104")).startsWith(BRIEFING.trimEnd())).toBe(true);

      const again = await runTransfersRefresh(db, { now: NOW });
      expect(again.plan.refresh).toEqual([]);
      expect(again.plan.inSync).toHaveLength(7);
    });

    test("claim appends nothing, so it renders nothing: the section is unchanged by a claim", async () => {
      const before = await specOf("mt#103");
      const claim = await claimWorkPackage(db, { taskId: "mt#103", claimedBy: CONV_A }, NOW);
      expect(claim.ok).toBe(true);
      expect(await specOf("mt#103")).toBe(before);
    });
  });
}

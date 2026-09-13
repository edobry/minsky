/**
 * mt#5132 — work-package lifecycle sweep against a real Postgres (testcontainer).
 *
 * The live exercise for the store: the close path (CAS READY/IN-PROGRESS →
 * DONE + `completed` transfer naming the members), the presence-staleness
 * release, idempotence, the zero-member report, and the SessionEnd seam
 * (`tasks.release-conversation`) — which releases a `conv:`-scoped claim, leaves
 * a `proc:`-scoped one alone, and keeps everything under `clear` / `resume`.
 * `system_events` carries the two values the writes emit.
 *
 * Gated like its siblings: RUN_INTEGRATION_TESTS=1 RUN_TESTCONTAINER_TESTS=1.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { GenericContainer, type WaitStrategy } from "testcontainers";
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { runWorkPackageLifecycleSweep } from "../../packages/domain/src/tasks/work-package-lifecycle-sweep";
import { createTasksReleaseConversationCommand } from "../../src/adapters/shared/commands/tasks/work-package-lifecycle-commands";

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
const CONV_A = "1d82ba6d-99e8-4d5e-bfb4-d8252aaaaaaa";
const CONV_B = "c7b70f3f-44bb-424c-876e-bc4afbbbbbbb";
const CONV_ACTOR_A = `com.anthropic.claude-code:conv:${CONV_A}`;
const CONV_ACTOR_B = `com.anthropic.claude-code:conv:${CONV_B}`;
const PROC_ACTOR = "com.anthropic.claude-code:proc:b0677f009dc6a76b";
const DEAD_PROC_ACTOR = "com.anthropic.claude-code:proc:1102e598466ff715";
const STATUS_EVENT = "task.status_changed";
const WORK_PACKAGE = "work-package";

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

if (process.env.RUN_INTEGRATION_TESTS && process.env.RUN_TESTCONTAINER_TESTS) {
  process.stdout.write(`[mt5132/testcontainer] starting ${POSTGRES_IMAGE}\n`);

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
  process.stdout.write(`[mt5132/testcontainer] ready at ${host}:${port}\n`);

  const sql = postgres(connectionString, { max: 5, prepare: false });
  const db = drizzle(sql) as PostgresJsDatabase;
  await sql.unsafe(DDL);

  // ── Fixture ─────────────────────────────────────────────────────────────────
  // A fixed clock; every age is anchored to it, never to the real clock.
  const NOW_MS = Date.UTC(2026, 8, 13, 12, 0, 0);
  const hoursAgo = (n: number) => new Date(NOW_MS - n * 3_600_000).toISOString();
  await sql`insert into projects (id) values (${PROJECT_ID})`;

  const task = async (id: string, status: string, kind = "implementation") => {
    await sql`insert into tasks (id, status, title, kind, project_id) values (${id}, ${status}, ${id}, ${kind}, ${PROJECT_ID})`;
  };
  const pkg = async (
    id: string,
    status: string,
    members: string[],
    claim?: { by: string; at: string }
  ) => {
    await sql`insert into tasks (id, status, title, kind, project_id, claimed_by, claimed_at)
      values (${id}, ${status}, ${id}, ${WORK_PACKAGE}, ${PROJECT_ID}, ${claim?.by ?? null}, ${claim?.at ?? null})`;
    for (const [i, m] of members.entries()) {
      await sql`insert into work_package_members (package_task_id, member_task_id, rank) values (${id}, ${m}, ${i + 1})`;
    }
    await sql`insert into work_package_transfers (package_task_id, seq, origin) values (${id}, 1, 'groomed')`;
  };
  const presence = async (actor: string, conv: string | null, subject: string, at: string) => {
    await sql`insert into presence_claims (subject_kind, subject_id, actor_id, cc_conversation_id, claimed_at, last_refreshed_at)
      values ('task', ${subject}, ${actor}, ${conv}, ${at}, ${at})`;
  };

  // Members
  for (const [id, status] of [
    ["mt#1", "DONE"],
    ["mt#2", "CLOSED"],
    ["mt#3", "DONE"],
    ["mt#4", "DONE"],
    ["mt#5", "DONE"],
    ["mt#6", "READY"],
    ["mt#7", "TODO"],
    ["mt#8", "IN-PROGRESS"],
    ["mt#9", "DONE"],
  ] as const) {
    await task(id, status);
  }

  // AT1: three-terminal → close; two-terminal-one-open → keep; zero members (AT5) → report.
  await pkg("mt#100", "READY", ["mt#1", "mt#2", "mt#3"]);
  await pkg("mt#101", "READY", ["mt#4", "mt#5", "mt#6"]);
  await pkg("mt#102", "READY", []);
  // Claimed and finished: close wins over release.
  await pkg("mt#103", "IN-PROGRESS", ["mt#9"], { by: DEAD_PROC_ACTOR, at: hoursAgo(72) });

  // AT3 (staleness): stale claim + stale presence → release; fresh presence → keep;
  // fresh claim + no presence → keep; conv-scoped matched through cc_conversation_id.
  await pkg("mt#110", "IN-PROGRESS", ["mt#7"], { by: DEAD_PROC_ACTOR, at: hoursAgo(25) });
  await presence(DEAD_PROC_ACTOR, null, "mt#7", hoursAgo(25));
  await pkg("mt#111", "IN-PROGRESS", ["mt#7"], { by: PROC_ACTOR, at: hoursAgo(25) });
  await presence(PROC_ACTOR, null, "mt#8", hoursAgo(1));
  // Free-text claim (the shape `tasks.claim` accepts): no presence can match it, so age alone decides.
  await pkg("mt#112", "IN-PROGRESS", ["mt#7"], { by: "conversation 01YT3free", at: hoursAgo(30) });
  await pkg("mt#113", "IN-PROGRESS", ["mt#8"], { by: CONV_ACTOR_B, at: hoursAgo(30) });
  // Presence for CONV_B was written under a DIFFERENT actor id (the proxy's), but stamps the conversation.
  await presence("com.anthropic.claude-code:proc:otherproxy", CONV_B, "mt#8", hoursAgo(1));

  // AT2 (release-conversation): CONV_A holds one package; a proc claim sits beside it.
  await pkg("mt#120", "IN-PROGRESS", ["mt#7"], { by: CONV_ACTOR_A, at: hoursAgo(1) });
  await pkg("mt#121", "IN-PROGRESS", ["mt#8"], { by: PROC_ACTOR, at: hoursAgo(1) });

  const statusOf = async (id: string): Promise<string> => {
    const [r] = await sql`select status from tasks where id = ${id}`;
    return String(r?.status);
  };
  const claimOf = async (id: string): Promise<string | null> => {
    const [r] = await sql`select claimed_by from tasks where id = ${id}`;
    return (r?.claimed_by as string | null) ?? null;
  };
  const transfersOf = async (
    id: string
  ): Promise<Array<{ seq: number; origin: string; notes: string | null }>> => {
    const rows =
      await sql`select seq, origin, notes from work_package_transfers where package_task_id = ${id} order by seq`;
    return rows.map((r) => ({
      seq: Number(r.seq),
      origin: String(r.origin),
      notes: (r.notes as string | null) ?? null,
    }));
  };
  const statusEvents = async (): Promise<
    Array<{ taskId: string | null; via: unknown; newStatus: unknown }>
  > => {
    const rows =
      await sql`select related_task_id, payload from system_events where event_type = ${STATUS_EVENT}::system_event_type order by created_at`;
    return rows.map((r) => {
      const p = r.payload as Record<string, unknown>;
      return {
        taskId: (r.related_task_id as string | null) ?? null,
        via: p.via,
        newStatus: p.newStatus,
      };
    });
  };

  describe("mt#5132 — work-package lifecycle sweep against a real Postgres", () => {
    afterAll(async () => {
      await sql.end().catch(() => {});
      await container.stop().catch(() => {});
    });

    test("AT1 + AT3 + AT5: the dry-run plans close {mt#100, mt#103}, release {mt#110, mt#112}, reports mt#102 empty, and writes nothing", async () => {
      const dry = await runWorkPackageLifecycleSweep(db, { nowMs: NOW_MS, via: "test" });
      expect(dry.dryRun).toBe(true);
      expect(dry.plan.close.map((c) => c.id).sort()).toEqual(["mt#100", "mt#103"]);
      expect(dry.plan.close.find((c) => c.id === "mt#100")?.memberIds).toEqual([
        "mt#1",
        "mt#2",
        "mt#3",
      ]);
      expect(dry.plan.release.map((r) => [r.id, r.reason]).sort()).toEqual([
        ["mt#110", "stale-presence"],
        ["mt#112", "no-presence"],
      ]);
      expect(dry.plan.zeroMembers).toEqual(["mt#102"]);
      // Kept, with the reason a reader can act on:
      const kept = Object.fromEntries(dry.plan.keep.map((k) => [k.id, k.reason]));
      expect(kept["mt#101"]).toBe("open-members");
      expect(kept["mt#102"]).toBe("zero-members");
      expect(kept["mt#111"]).toBe("open-members; presence-fresh"); // fresh presence keeps a 25h claim
      expect(kept["mt#113"]).toBe("open-members; presence-fresh"); // conv-scoped, matched by cc_conversation_id
      expect(kept["mt#120"]).toBe("open-members; claim-fresh");
      expect(kept["mt#121"]).toBe("open-members; claim-fresh");
      expect(dry.applied).toEqual({ closed: [], released: [], refused: [] });
      expect(await statusOf("mt#100")).toBe("READY");
      expect(await statusOf("mt#110")).toBe("IN-PROGRESS");
      expect(await statusEvents()).toEqual([]);
    });

    test("AT1 + AT3: --execute produces exactly the plan — DONE + completed transfer naming the members; READY + release transfer naming the staleness — and a second run is 0 / 0", async () => {
      const run = await runWorkPackageLifecycleSweep(db, {
        nowMs: NOW_MS,
        execute: true,
        via: "test",
      });
      expect(run.applied.closed.sort()).toEqual(["mt#100", "mt#103"]);
      expect(run.applied.released.sort()).toEqual(["mt#110", "mt#112"]);
      expect(run.applied.refused).toEqual([]);

      expect(await statusOf("mt#100")).toBe("DONE");
      expect(await statusOf("mt#103")).toBe("DONE");
      expect(await claimOf("mt#103")).toBeNull();
      const t100 = await transfersOf("mt#100");
      expect(t100.map((t) => t.origin)).toEqual(["groomed", "completed"]);
      expect(t100[1]?.notes).toContain("mt#1, mt#2, mt#3");
      expect(t100[1]?.notes).toContain("via test");

      expect(await statusOf("mt#110")).toBe("READY");
      expect(await claimOf("mt#110")).toBeNull();
      const t110 = await transfersOf("mt#110");
      expect(t110.map((t) => t.origin)).toEqual(["groomed", "release"]);
      expect(t110[1]?.notes).toContain(DEAD_PROC_ACTOR);
      expect(t110[1]?.notes).toContain("last presence at");
      expect((await transfersOf("mt#112"))[1]?.notes).toContain("no presence recorded");

      // Untouched: partly-open, empty, fresh-presence, conv-matched, fresh-claim.
      for (const id of ["mt#101", "mt#102"]) expect(await statusOf(id)).toBe("READY");
      for (const id of ["mt#111", "mt#113", "mt#120", "mt#121"]) {
        expect(await statusOf(id)).toBe("IN-PROGRESS");
      }

      const events = await statusEvents();
      expect(events.map((e) => [e.taskId, e.newStatus, e.via]).sort()).toEqual([
        ["mt#100", "DONE", "work-package.complete"],
        ["mt#103", "DONE", "work-package.complete"],
        ["mt#110", "READY", "work-package.release"],
        ["mt#112", "READY", "work-package.release"],
      ]);

      const again = await runWorkPackageLifecycleSweep(db, {
        nowMs: NOW_MS,
        execute: true,
        via: "test",
      });
      expect(again.plan.close).toEqual([]);
      expect(again.plan.release).toEqual([]);
      expect(again.applied).toEqual({ closed: [], released: [], refused: [] });
    });

    test("AT2: release-conversation releases the conv:-scoped claim, leaves the proc: one, and keeps both under clear / resume", async () => {
      const command = createTasksReleaseConversationCommand(() => ({
        getDatabaseConnection: async () => db,
      }));
      const run = async (reason: string) =>
        (await command.execute({ conversationId: CONV_A, reason } as never, {} as never)) as {
          success: boolean;
          skipped: boolean;
          matched: string[];
          released: string[];
        };

      for (const reason of ["clear", "resume"]) {
        const out = await run(reason);
        expect(out).toMatchObject({ success: true, skipped: true, matched: [], released: [] });
        expect(await statusOf("mt#120")).toBe("IN-PROGRESS");
      }

      const out = await run("other");
      expect(out).toMatchObject({
        success: true,
        skipped: false,
        matched: ["mt#120"],
        released: ["mt#120"],
      });
      expect(await statusOf("mt#120")).toBe("READY");
      expect(await claimOf("mt#120")).toBeNull();
      const t120 = await transfersOf("mt#120");
      expect(t120[1]?.origin).toBe("release");
      expect(t120[1]?.notes).toContain("SessionEnd (reason: other)");
      expect(t120[1]?.notes).toContain(CONV_A);
      // The proc:-scoped neighbour is not this conversation's to release.
      expect(await statusOf("mt#121")).toBe("IN-PROGRESS");
      expect(await claimOf("mt#121")).toBe(PROC_ACTOR);
      // A second call finds nothing.
      expect(await run("other")).toMatchObject({ matched: [], released: [] });
    });

    test("release-conversation's validate() refuses a non-uuid conversation id rather than building a pattern from it", async () => {
      const command = createTasksReleaseConversationCommand(() => ({
        getDatabaseConnection: async () => db,
      }));
      // The registry runs validate() before execute(); calling it directly is the same gate.
      await expect(
        command.validate?.({ conversationId: "%", reason: "other" } as never, {} as never)
      ).rejects.toThrow(/must be a uuid/);
      await expect(
        command.validate?.({ conversationId: CONV_A, reason: "other" } as never, {} as never)
      ).resolves.toBeUndefined();
    });
  });
}

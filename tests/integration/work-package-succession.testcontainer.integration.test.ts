/**
 * mt#5133 — work-package succession against a real Postgres (testcontainer).
 *
 * The live exercise for `tasks.package.succeed`: the spec form runs through the
 * COMMAND (with a container whose task service answers from the tasks table),
 * so the create-seam validation, the store transaction and the release are
 * exercised as wired; the members form and the refusals run against the store
 * directly. AT1: members replaced in order, briefing replaced, `## Transfers`
 * rendered, one `succession` + one `release` transfer, READY, claim cleared,
 * no new package row. AT2: a READY package and an empty resulting member set
 * are refused with nothing written.
 *
 * Gated like its siblings: RUN_INTEGRATION_TESTS=1 RUN_TESTCONTAINER_TESTS=1.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { GenericContainer, type WaitStrategy } from "testcontainers";
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { succeedWorkPackage } from "../../packages/domain/src/tasks/work-package-succession";
import { TRANSFERS_HEADING } from "../../packages/domain/src/tasks/work-package-briefing";
import { createTasksPackageSucceedCommand } from "../../src/adapters/shared/commands/tasks/work-package-succession-command";

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
const CONV_ACTOR_A = "com.anthropic.claude-code:conv:1d82ba6d-99e8-4d5e-bfb4-d8252aaaaaaa";
const CURATOR = "com.anthropic.claude-code:proc:b0677f009dc6a76b";
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

const ORIGINAL_BRIEFING = `# Handoff: onboarding queue

Origin: succession

## Situation

Hop one: nothing shipped yet.

## Decisions

None yet.

## Provenance

Written by the curator.

## Members

1. mt#1 — first
2. mt#2 — second
3. mt#3 — third

## Open threads

- ask#none
`;

const REPLACEMENT_BRIEFING = `# Handoff: onboarding queue

Origin: succession

## Situation

mt#1 shipped this hop; mt#2 and mt#3 remain; mt#4 surfaced in review.

## Decisions

Kept mt#3 ahead of mt#4 — it unblocks the deploy.

## Provenance

Written by conversation A at 12:00Z.

## Members

1. mt#2 — next: the migration
2. mt#3 — unblocks the deploy
3. mt#4
`;

if (process.env.RUN_INTEGRATION_TESTS && process.env.RUN_TESTCONTAINER_TESTS) {
  process.stdout.write(`[mt5133/testcontainer] starting ${POSTGRES_IMAGE}\n`);

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
  process.stdout.write(`[mt5133/testcontainer] ready at ${host}:${port}\n`);

  const sql = postgres(connectionString, { max: 5, prepare: false });
  const db = drizzle(sql) as PostgresJsDatabase;
  await sql.unsafe(DDL);

  // ── Fixture ─────────────────────────────────────────────────────────────────
  const NOW = new Date(Date.UTC(2026, 8, 13, 12, 0, 0));
  await sql`insert into projects (id) values (${PROJECT_ID})`;

  const task = async (id: string, status: string) => {
    await sql`insert into tasks (id, status, title, kind, project_id) values (${id}, ${status}, ${id}, 'implementation', ${PROJECT_ID})`;
  };
  const pkg = async (
    id: string,
    status: string,
    members: Array<[string, string | null]>,
    claimedBy: string | null
  ) => {
    await sql`insert into tasks (id, status, title, kind, project_id, claimed_by, claimed_at)
      values (${id}, ${status}, ${id}, ${WORK_PACKAGE}, ${PROJECT_ID}, ${claimedBy}, ${claimedBy ? NOW.toISOString() : null})`;
    await sql`insert into task_specs (task_id, content) values (${id}, ${ORIGINAL_BRIEFING})`;
    for (const [i, [m, rationale]] of members.entries()) {
      await sql`insert into work_package_members (package_task_id, member_task_id, rank, rationale) values (${id}, ${m}, ${i + 1}, ${rationale})`;
    }
    await sql`insert into work_package_transfers (package_task_id, seq, origin, by_conversation, notes, created_at)
      values (${id}, 1, 'groomed', ${CURATOR}, 'curated', ${new Date(NOW.getTime() - 3_600_000).toISOString()})`;
  };

  for (const [id, status] of [
    ["mt#1", "DONE"],
    ["mt#2", "READY"],
    ["mt#3", "TODO"],
    ["mt#4", "TODO"],
    ["mt#5", "READY"],
  ] as const) {
    await task(id, status);
  }
  const MEMBERS_ABC: Array<[string, string | null]> = [
    ["mt#1", "first"],
    ["mt#2", "second"],
    ["mt#3", "third"],
  ];
  await pkg("mt#100", "IN-PROGRESS", MEMBERS_ABC, CONV_ACTOR_A); // AT1 spec form, via the command
  await pkg("mt#101", "IN-PROGRESS", MEMBERS_ABC, CONV_ACTOR_A); // AT1 members form
  await pkg("mt#102", "READY", MEMBERS_ABC, null); // AT2 not claimed
  await pkg("mt#103", "IN-PROGRESS", MEMBERS_ABC, CONV_ACTOR_A); // AT2 empty members
  await pkg("mt#104", "IN-PROGRESS", MEMBERS_ABC, CONV_ACTOR_A); // releaseClaim: false
  await pkg("mt#105", "IN-PROGRESS", MEMBERS_ABC, null); // R1: IN-PROGRESS with no holder
  await pkg("mt#106", "IN-PROGRESS", MEMBERS_ABC, CONV_ACTOR_A); // R1: duplicate ref in the list

  const rowOf = async (id: string) => {
    const [r] = await sql`select status, claimed_by from tasks where id = ${id}`;
    return { status: String(r?.status), claimedBy: (r?.claimed_by as string | null) ?? null };
  };
  const membersOf = async (id: string) => {
    const rows =
      await sql`select member_task_id, rank, status_at_write, rationale from work_package_members where package_task_id = ${id} order by rank`;
    return rows.map((r) => ({
      taskId: String(r.member_task_id),
      rank: Number(r.rank),
      statusAtWrite: (r.status_at_write as string | null) ?? null,
      rationale: (r.rationale as string | null) ?? null,
    }));
  };
  const transfersOf = async (id: string) => {
    const rows =
      await sql`select seq, origin, by_conversation, notes from work_package_transfers where package_task_id = ${id} order by seq`;
    return rows.map((r) => ({
      seq: Number(r.seq),
      origin: String(r.origin),
      byConversation: (r.by_conversation as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
    }));
  };
  const specOf = async (id: string): Promise<string> => {
    const [r] = await sql`select content from task_specs where task_id = ${id}`;
    return String(r?.content ?? "");
  };
  const packageCount = async (): Promise<number> => {
    const [r] = await sql`select count(*)::int as n from tasks where kind = ${WORK_PACKAGE}`;
    return Number(r?.n);
  };
  const statusEvents = async (id: string) => {
    const rows =
      await sql`select payload from system_events where event_type = ${STATUS_EVENT}::system_event_type and related_task_id = ${id} order by created_at`;
    return rows.map((r) => {
      const p = r.payload as Record<string, unknown>;
      return { via: p.via, newStatus: p.newStatus };
    });
  };

  // The command's ref resolvers read `container.get("taskService").getTask(id)`;
  // answer from the tasks table so the seam is the real one.
  const fakeContainer = {
    has: (name: string) => name === "taskService",
    get: (name: string) => {
      if (name !== "taskService") throw new Error(`unexpected service ${name}`);
      return {
        getTask: async (id: string) => {
          const [r] = await sql`select id, status, title from tasks where id = ${id}`;
          return r ? { id: String(r.id), status: String(r.status), title: String(r.title) } : null;
        },
      };
    },
  } as never;
  const provider = { getDatabaseConnection: async () => db };
  const command = createTasksPackageSucceedCommand(() => provider, fakeContainer);

  describe("mt#5133 — work-package succession against a real Postgres", () => {
    afterAll(async () => {
      await sql.end().catch(() => {});
      await container.stop().catch(() => {});
    });

    test("AT1 (spec form, through the command): members [B,C,D] in order, briefing replaced, ## Transfers rendered, succession + release transfers, READY, claim cleared, no new row", async () => {
      const before = await packageCount();
      const result = (await command.execute(
        {
          taskId: "mt#100",
          notes: "mt#1 shipped; mt#2 next; mt#4 surfaced in review",
          spec: REPLACEMENT_BRIEFING,
          releaseClaim: true,
          callerActorId: CONV_ACTOR_A,
        } as never,
        {} as never
      )) as Record<string, unknown>;
      expect(result.success).toBe(true);
      expect(result.members).toEqual(["mt#2", "mt#3", "mt#4"]);
      expect(result.transferSeq).toBe(2);
      expect(result.status).toBe("READY");

      expect(await membersOf("mt#100")).toEqual([
        { taskId: "mt#2", rank: 1, statusAtWrite: "READY", rationale: "next: the migration" },
        { taskId: "mt#3", rank: 2, statusAtWrite: "TODO", rationale: "unblocks the deploy" },
        { taskId: "mt#4", rank: 3, statusAtWrite: "TODO", rationale: null },
      ]);
      expect(await transfersOf("mt#100")).toEqual([
        { seq: 1, origin: "groomed", byConversation: CURATOR, notes: "curated" },
        {
          seq: 2,
          origin: "succession",
          byConversation: CONV_ACTOR_A,
          notes: "mt#1 shipped; mt#2 next; mt#4 surfaced in review",
        },
        {
          seq: 3,
          origin: "release",
          byConversation: CONV_ACTOR_A,
          notes: "Released after succession transfer #2.",
        },
      ]);
      expect(await rowOf("mt#100")).toEqual({ status: "READY", claimedBy: null });
      expect(await packageCount()).toBe(before);

      const spec = await specOf("mt#100");
      expect(spec.startsWith(REPLACEMENT_BRIEFING.trimEnd())).toBe(true);
      expect(spec).not.toContain("Hop one");
      const transfersAt = spec.indexOf(TRANSFERS_HEADING);
      expect(transfersAt).toBeGreaterThan(0);
      const section = spec.slice(transfersAt);
      expect(section).toContain("- #1 groomed — ");
      expect(section).toContain(`- #2 succession — `);
      expect(section).toContain(
        `by ${CONV_ACTOR_A} — mt#1 shipped; mt#2 next; mt#4 surfaced in review`
      );
      expect(section).toContain("- #3 release — ");
      expect(spec.match(/## Transfers/g)).toHaveLength(1);

      expect(await statusEvents("mt#100")).toEqual([
        { via: "work-package.release", newStatus: "READY" },
      ]);
    });

    test("AT1 (members form): rows [B,E] with carried rationale, only ## Members rewritten, rest of the briefing kept", async () => {
      const out = await succeedWorkPackage(
        db,
        {
          taskId: "mt#101",
          spec: null,
          members: [
            { taskId: "mt#2", rationale: null, statusAtWrite: "READY" },
            { taskId: "mt#5", rationale: null, statusAtWrite: "READY" },
          ],
          byConversation: CONV_ACTOR_A,
          notes: "reordered",
          releaseClaim: true,
        },
        NOW
      );
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error("unreachable");
      expect(out.members).toEqual(["mt#2", "mt#5"]);
      expect(out.release?.ok).toBe(true);

      expect(await membersOf("mt#101")).toEqual([
        { taskId: "mt#2", rank: 1, statusAtWrite: "READY", rationale: "second" },
        { taskId: "mt#5", rank: 2, statusAtWrite: "READY", rationale: null },
      ]);
      const spec = await specOf("mt#101");
      expect(spec).toContain("Hop one: nothing shipped yet.");
      expect(spec).toContain("## Open threads\n\n- ask#none");
      expect(spec).toContain("## Members\n\n- mt#2 — second\n- mt#5\n");
      expect(spec).not.toContain("mt#3 — third");
      expect(spec.match(/## Members/g)).toHaveLength(1);
      expect(spec.match(/## Transfers/g)).toHaveLength(1);
      expect(spec.slice(spec.indexOf(TRANSFERS_HEADING))).toContain("- #3 release — ");
      expect(await rowOf("mt#101")).toEqual({ status: "READY", claimedBy: null });
    });

    test("AT2: a READY (unclaimed) package is refused and nothing is written", async () => {
      const specBefore = await specOf("mt#102");
      const out = await succeedWorkPackage(db, {
        taskId: "mt#102",
        spec: REPLACEMENT_BRIEFING,
        members: [{ taskId: "mt#2", rationale: null, statusAtWrite: "READY" }],
        byConversation: CONV_ACTOR_A,
        notes: "should not land",
        releaseClaim: true,
      });
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("unreachable");
      expect(out.reason).toBe("not-claimed");
      expect((await membersOf("mt#102")).map((m) => m.taskId)).toEqual(["mt#1", "mt#2", "mt#3"]);
      expect(await transfersOf("mt#102")).toHaveLength(1);
      expect(await specOf("mt#102")).toBe(specBefore);
      expect(await rowOf("mt#102")).toEqual({ status: "READY", claimedBy: null });
    });

    test("AT2: an empty resulting member set is refused with the close-instead reason; claim kept, nothing written", async () => {
      const out = await succeedWorkPackage(db, {
        taskId: "mt#103",
        spec: null,
        members: [],
        byConversation: CONV_ACTOR_A,
        notes: "all done",
        releaseClaim: true,
      });
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("unreachable");
      expect(out.reason).toBe("empty-members");
      expect(await membersOf("mt#103")).toHaveLength(3);
      expect(await transfersOf("mt#103")).toHaveLength(1);
      expect(await specOf("mt#103")).toBe(ORIGINAL_BRIEFING);
      expect(await rowOf("mt#103")).toEqual({ status: "IN-PROGRESS", claimedBy: CONV_ACTOR_A });
      expect(await statusEvents("mt#103")).toEqual([]);
    });

    test("R1: an IN-PROGRESS package with no recorded holder is refused, nothing written", async () => {
      const out = await succeedWorkPackage(db, {
        taskId: "mt#105",
        spec: null,
        members: [{ taskId: "mt#2", rationale: null, statusAtWrite: "READY" }],
        byConversation: CONV_ACTOR_A,
        notes: "should not land",
        releaseClaim: true,
      });
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("unreachable");
      expect(out.reason).toBe("not-claimed");
      expect(out.message).toContain("records no holder");
      expect(await membersOf("mt#105")).toHaveLength(3);
      expect(await transfersOf("mt#105")).toHaveLength(1);
      expect(await rowOf("mt#105")).toEqual({ status: "IN-PROGRESS", claimedBy: null });
    });

    test("R1: a member ref given twice writes one row at its first position (no PK violation)", async () => {
      const out = await succeedWorkPackage(
        db,
        {
          taskId: "mt#106",
          spec: null,
          members: [
            { taskId: "mt#3", rationale: null, statusAtWrite: "TODO" },
            { taskId: "mt#2", rationale: null, statusAtWrite: "READY" },
            { taskId: "mt#3", rationale: "again", statusAtWrite: "TODO" },
          ],
          byConversation: CONV_ACTOR_A,
          notes: "dup",
          releaseClaim: false,
        },
        NOW
      );
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error("unreachable");
      expect(out.members).toEqual(["mt#3", "mt#2"]);
      expect((await membersOf("mt#106")).map((m) => [m.taskId, m.rank])).toEqual([
        ["mt#3", 1],
        ["mt#2", 2],
      ]);
    });

    test("releaseClaim false: succession recorded, ## Transfers lists it, package still held", async () => {
      const out = await succeedWorkPackage(
        db,
        {
          taskId: "mt#104",
          spec: null,
          members: null,
          byConversation: CONV_ACTOR_A,
          notes: "checkpoint",
          releaseClaim: false,
        },
        NOW
      );
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error("unreachable");
      expect(out.release).toBeNull();
      expect(out.status).toBe("IN-PROGRESS");
      expect(out.members).toEqual(["mt#1", "mt#2", "mt#3"]);
      expect((await transfersOf("mt#104")).map((t) => t.origin)).toEqual(["groomed", "succession"]);
      const section = (await specOf("mt#104")).slice(
        (await specOf("mt#104")).indexOf(TRANSFERS_HEADING)
      );
      expect(section).toContain(
        `- #2 succession — ${NOW.toISOString()} — by ${CONV_ACTOR_A} — checkpoint`
      );
      expect(section).not.toContain("release");
      expect(await rowOf("mt#104")).toEqual({ status: "IN-PROGRESS", claimedBy: CONV_ACTOR_A });
    });
  });
}

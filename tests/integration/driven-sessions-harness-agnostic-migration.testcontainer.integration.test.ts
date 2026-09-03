/**
 * mt#4935 AT1 — migration 0117 (harness_kind/transport_id/harness_conversation_id/
 * auth_mode) against a REAL Postgres.
 *
 * The migration's whole job is a backfill: three columns get a constant
 * DB-level default that Postgres applies to every EXISTING row at
 * `ADD COLUMN` time (no separate UPDATE, no full-table rewrite), and a
 * fourth (`harness_conversation_id`) is backfilled with an explicit
 * `UPDATE ... SET harness_conversation_id = harness_session_id`. Whether an
 * `ADD COLUMN ... DEFAULT 'x' NOT NULL` actually backfills existing rows (as
 * opposed to merely accepting new ones going forward) is a property of
 * Postgres's own DDL semantics — not something a hand-rolled fake can stand
 * in for (mem#704: a probe that can't fail isn't verification).
 *
 * This test builds the table in the SHAPE migration 0116 left it (every
 * column except the four this migration adds), seeds rows that predate the
 * migration — including one with a NULL `harness_session_id`, the case that
 * proves the backfill does not invent a value where the source had none —
 * and then runs the ACTUAL migration file read off disk, so an edit to the
 * SQL is what this test verifies, not a hand-copied reproduction of it.
 *
 * Gate: TWO env vars, both required (matching the sibling harnesses):
 *   RUN_INTEGRATION_TESTS=1
 *   RUN_TESTCONTAINER_TESTS=1
 *
 * Run:
 *   RUN_INTEGRATION_TESTS=1 RUN_TESTCONTAINER_TESTS=1 \
 *     bun test --preload ./tests/setup.ts --timeout=300000 \
 *       tests/integration/driven-sessions-harness-agnostic-migration.testcontainer.integration.test.ts
 */
/* eslint-disable custom/no-real-fs-in-tests -- the whole point of this test is verifying the ACTUAL migration file on disk, not a hand-copied reproduction of its SQL; reading it is the test's contract, not a shortcut around dependency injection. */
import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { GenericContainer, type StartedTestContainer, type WaitStrategy } from "testcontainers";
import postgres from "postgres";

const GATED =
  process.env.RUN_INTEGRATION_TESTS === "1" && process.env.RUN_TESTCONTAINER_TESTS === "1";

const MIGRATION_PATH = join(
  __dirname,
  "../../packages/domain/src/storage/migrations/pg/0117_mixed_doctor_doom.sql"
);

const DEFAULT_TRANSPORT_ID = "claude-stream-json";

/**
 * No-op wait strategy — every built-in testcontainers strategy hangs under Bun
 * (docker-socket/child_process polling incompatibility). Readiness is the SQL
 * probe below. Copied from the sibling harnesses deliberately rather than
 * shared: coupling the suites through a shared export makes either one's
 * bring-up changes break the other.
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
    // intentional-swallow: a container that failed to stop cannot fail the
    // run — the harness already has its verdict, and Docker reaps it anyway.
  });
});

async function bringUp(): Promise<void> {
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

  // The PRE-migration shape (everything migration 0116 and earlier produced) —
  // written out rather than run through the full migrator chain, so this
  // harness pins the shape the 0117 migration expects to find. `gen_random_uuid()`
  // needs pgcrypto on some Postgres images; driven_sessions' PK is plain text
  // (localId), so nothing here needs it.
  await sql`
    CREATE TABLE driven_sessions (
      local_id text PRIMARY KEY,
      harness_session_id text,
      cwd text NOT NULL,
      permission_mode text NOT NULL,
      task_id text,
      minsky_session_id text,
      model text,
      status text NOT NULL,
      unrecoverable_reason text,
      pid integer,
      pid_cmdline text,
      driver_generation integer NOT NULL DEFAULT 0,
      started_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
}

async function seedRow(row: {
  localId: string;
  harnessSessionId: string | null;
  status?: string;
}): Promise<void> {
  await conn()`
    INSERT INTO driven_sessions (local_id, harness_session_id, cwd, permission_mode, status, started_at)
    VALUES (${row.localId}, ${row.harnessSessionId}, '/tmp/x', 'bypassPermissions', ${row.status ?? "exited"}, now())`;
}

describe.skipIf(!GATED)(
  "migration 0117 — harness-agnostic driven_sessions backfill (mt#4935)",
  () => {
    test("AT1: every existing row backfills to claude-code/claude-stream-json/its prior harness_session_id/subscription; row count unchanged", async () => {
      await bringUp();

      // Three pre-migration rows, including the case that proves the backfill
      // doesn't invent a value: a row whose harness_session_id was never linked.
      await seedRow({ localId: "local-linked-1", harnessSessionId: "harness-abc" });
      await seedRow({ localId: "local-linked-2", harnessSessionId: "harness-def" });
      await seedRow({
        localId: "local-never-linked",
        harnessSessionId: null,
        status: "unrecoverable",
      });

      const beforeCount = await conn()`SELECT count(*)::int AS n FROM driven_sessions`;
      expect(beforeCount[0]?.n).toBe(3);

      // `String(...)` rather than relying on the encoding argument to narrow:
      // this project ships a narrowed ambient `node:fs` (`src/types/node.d.ts:25`)
      // declaring one overload that returns `string | Buffer` regardless of
      // options, so no argument makes it a `string` (same idiom as
      // driven-session-mcp-config.ts's `readOperatorMcpServers`).
      const migrationSql = String(readFileSync(MIGRATION_PATH, "utf-8"));
      await conn().unsafe(migrationSql);

      const afterCount = await conn()`SELECT count(*)::int AS n FROM driven_sessions`;
      expect(afterCount[0]?.n).toBe(3);

      const rows = await conn()`
      SELECT local_id, harness_kind, transport_id, harness_conversation_id, auth_mode,
             harness_session_id
      FROM driven_sessions ORDER BY local_id`;

      const linked1 = rows.find((r) => r.local_id === "local-linked-1");
      expect(linked1?.harness_kind).toBe("claude-code");
      expect(linked1?.transport_id).toBe(DEFAULT_TRANSPORT_ID);
      expect(linked1?.harness_conversation_id).toBe("harness-abc");
      expect(linked1?.auth_mode).toBe("subscription");

      const linked2 = rows.find((r) => r.local_id === "local-linked-2");
      expect(linked2?.harness_conversation_id).toBe("harness-def");

      // The unlinked row's harness_session_id was NULL — the backfill must
      // carry that NULL through, not synthesize a value.
      const neverLinked = rows.find((r) => r.local_id === "local-never-linked");
      expect(neverLinked?.harness_session_id).toBeNull();
      expect(neverLinked?.harness_conversation_id).toBeNull();
      expect(neverLinked?.harness_kind).toBe("claude-code");
      expect(neverLinked?.transport_id).toBe(DEFAULT_TRANSPORT_ID);
      expect(neverLinked?.auth_mode).toBe("subscription");
    });

    test("harness_kind/transport_id/auth_mode are NOT NULL after the migration; harness_conversation_id stays nullable", async () => {
      const columns = await conn()`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'driven_sessions'
        AND column_name IN ('harness_kind', 'transport_id', 'harness_conversation_id', 'auth_mode')
      ORDER BY column_name`;

      const byName = Object.fromEntries(columns.map((c) => [c.column_name, c.is_nullable]));
      expect(byName.harness_kind).toBe("NO");
      expect(byName.transport_id).toBe("NO");
      expect(byName.auth_mode).toBe("NO");
      expect(byName.harness_conversation_id).toBe("YES");
    });

    test("a fresh row inserted after the migration gets the column defaults with no explicit values", async () => {
      await conn()`
      INSERT INTO driven_sessions (local_id, harness_session_id, cwd, permission_mode, status, started_at)
      VALUES ('local-post-migration', NULL, '/tmp/y', 'bypassPermissions', 'spawned', now())`;

      const rows = await conn()`
      SELECT harness_kind, transport_id, auth_mode, harness_conversation_id
      FROM driven_sessions WHERE local_id = 'local-post-migration'`;

      expect(rows[0]?.harness_kind).toBe("claude-code");
      expect(rows[0]?.transport_id).toBe(DEFAULT_TRANSPORT_ID);
      expect(rows[0]?.auth_mode).toBe("subscription");
      expect(rows[0]?.harness_conversation_id).toBeNull();
    });
  }
);

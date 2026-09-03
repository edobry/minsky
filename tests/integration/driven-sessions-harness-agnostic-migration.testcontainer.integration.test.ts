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
 * Each test gets its OWN Postgres SCHEMA — its own pre-migration
 * `driven_sessions` table, its own single-connection client pinned to that
 * schema via `search_path` set at connection-establishment time (not a
 * runtime `SET`, which would race across a pooled client) — sharing only the
 * one expensive-to-start container (PR #3595 R1 finding 5). Order-independent
 * by construction: nothing about test B's outcome depends on whether test A
 * ran first, because each has its own table and its own migration run against
 * it. Verified by running with test order REVERSED (see the PR body's
 * Execution evidence).
 *
 * Every test reads the ACTUAL migration file off disk and runs it, so an
 * edit to the SQL is what this test verifies, not a hand-copied reproduction
 * of it.
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
let containerBaseUrl: Promise<string> | undefined;
const openClients: ReturnType<typeof postgres>[] = [];

afterAll(async () => {
  await Promise.all(openClients.splice(0).map((c) => c.end({ timeout: 5 })));
  await container?.stop().catch(() => {
    // intentional-swallow: a container that failed to stop cannot fail the
    // run — the harness already has its verdict, and Docker reaps it anyway.
  });
});

/** Bring up the (single, shared) container — idempotent, lazy, order-independent. */
async function ensureContainer(): Promise<string> {
  containerBaseUrl ??= bringUpContainer();
  return containerBaseUrl;
}

async function bringUpContainer(): Promise<string> {
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
  const probe = postgres(url, { max: 1, onnotice: () => {} });
  try {
    for (let i = 0; i < 60; i++) {
      try {
        await probe`SELECT 1`;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } finally {
    await probe.end();
  }
  return url;
}

/**
 * A fresh, isolated pre-migration `driven_sessions` table, in its own
 * Postgres SCHEMA, plus a dedicated single-connection (`max: 1`) client
 * pinned to that schema via `search_path` set at connection-establishment
 * time — never a runtime `SET`, which would race across a pooled client's
 * multiple physical connections. Every test calls this with its OWN schema
 * name, so no test's rows or migration-application timing can affect
 * another's (PR #3595 R1 finding 5).
 */
async function bringUpIsolatedPreMigrationTable(
  schemaName: string
): Promise<ReturnType<typeof postgres>> {
  const baseUrl = await ensureContainer();

  const admin = postgres(baseUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
  } finally {
    await admin.end();
  }

  const client = postgres(baseUrl, {
    max: 1,
    onnotice: () => {},
    connection: { search_path: schemaName },
  });
  openClients.push(client);

  // The PRE-migration shape (everything migration 0116 and earlier produced) —
  // written out rather than run through the full migrator chain, so this
  // harness pins the shape the 0117 migration expects to find.
  await client.unsafe(`
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
    )`);

  return client;
}

function readMigrationSql(): string {
  // `String(...)` rather than relying on the encoding argument to narrow:
  // this project ships a narrowed ambient `node:fs` (`src/types/node.d.ts:25`)
  // declaring one overload that returns `string | Buffer` regardless of
  // options, so no argument makes it a `string` (same idiom as
  // driven-session-mcp-config.ts's `readOperatorMcpServers`).
  return String(readFileSync(MIGRATION_PATH, "utf-8"));
}

async function seedRow(
  client: ReturnType<typeof postgres>,
  row: { localId: string; harnessSessionId: string | null; status?: string }
): Promise<void> {
  await client`
    INSERT INTO driven_sessions (local_id, harness_session_id, cwd, permission_mode, status, started_at)
    VALUES (${row.localId}, ${row.harnessSessionId}, '/tmp/x', 'bypassPermissions', ${row.status ?? "exited"}, now())`;
}

describe.skipIf(!GATED)(
  "migration 0117 — harness-agnostic driven_sessions backfill (mt#4935)",
  () => {
    test("AT1: every existing row backfills to claude-code/claude-stream-json/its prior harness_session_id/subscription; row count unchanged", async () => {
      const client = await bringUpIsolatedPreMigrationTable("mt4935_at1");

      // Three pre-migration rows, including the case that proves the backfill
      // doesn't invent a value: a row whose harness_session_id was never linked.
      await seedRow(client, { localId: "local-linked-1", harnessSessionId: "harness-abc" });
      await seedRow(client, { localId: "local-linked-2", harnessSessionId: "harness-def" });
      await seedRow(client, {
        localId: "local-never-linked",
        harnessSessionId: null,
        status: "unrecoverable",
      });

      const beforeCount = await client`SELECT count(*)::int AS n FROM driven_sessions`;
      expect(beforeCount[0]?.n).toBe(3);

      await client.unsafe(readMigrationSql());

      const afterCount = await client`SELECT count(*)::int AS n FROM driven_sessions`;
      expect(afterCount[0]?.n).toBe(3);

      const rows = await client`
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
      const client = await bringUpIsolatedPreMigrationTable("mt4935_notnull");
      await client.unsafe(readMigrationSql());

      // `current_schema()`, not a hardcoded schema-name literal repeated from
      // the bring-up call: `information_schema.columns` is NOT scoped by
      // `search_path`, so every isolated test's OWN `driven_sessions` table
      // would otherwise all match `table_name = 'driven_sessions'` at once.
      const columns = await client`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'driven_sessions'
        AND table_schema = current_schema()
        AND column_name IN ('harness_kind', 'transport_id', 'harness_conversation_id', 'auth_mode')
      ORDER BY column_name`;

      const byName = Object.fromEntries(columns.map((c) => [c.column_name, c.is_nullable]));
      expect(byName.harness_kind).toBe("NO");
      expect(byName.transport_id).toBe("NO");
      expect(byName.auth_mode).toBe("NO");
      expect(byName.harness_conversation_id).toBe("YES");
    });

    test("a fresh row inserted after the migration gets the column defaults with no explicit values", async () => {
      const client = await bringUpIsolatedPreMigrationTable("mt4935_freshrow");
      await client.unsafe(readMigrationSql());

      await client`
      INSERT INTO driven_sessions (local_id, harness_session_id, cwd, permission_mode, status, started_at)
      VALUES ('local-post-migration', NULL, '/tmp/y', 'bypassPermissions', 'spawned', now())`;

      const rows = await client`
      SELECT harness_kind, transport_id, auth_mode, harness_conversation_id
      FROM driven_sessions WHERE local_id = 'local-post-migration'`;

      expect(rows[0]?.harness_kind).toBe("claude-code");
      expect(rows[0]?.transport_id).toBe(DEFAULT_TRANSPORT_ID);
      expect(rows[0]?.auth_mode).toBe("subscription");
      expect(rows[0]?.harness_conversation_id).toBeNull();
    });
  }
);

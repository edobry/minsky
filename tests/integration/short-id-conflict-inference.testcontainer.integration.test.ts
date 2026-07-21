/**
 * short_id ON CONFLICT inference — Testcontainers + real Postgres (mt#3005)
 *
 * Regression coverage for the mt#2966/mt#2967 production incident: migrations
 * 0066/0067 declared the `sessions.short_id` / `memories.short_id` unique
 * indexes as PARTIAL (`WHERE short_id IS NOT NULL`), but the insert code
 * (`DrizzleSessionRepository.addSession`, `MemoryService.create`) uses a bare
 * `.onConflictDoNothing({ target: table.shortId })` with no predicate.
 * Postgres only infers a partial unique index as an ON CONFLICT arbiter when
 * the conflict target's own WHERE clause matches the index predicate — a bare
 * column target never matches a partial index, so EVERY session/memory
 * insert failed with "no unique or exclusion constraint matching the ON
 * CONFLICT specification" in production (2026-07-21, discovered dispatching
 * mt#3002).
 *
 * This is the exact gap the mt#3005 spec calls out: the mt#2966/mt#2967 PRs'
 * tests all used fake `db` objects (see
 * `packages/domain/src/session/drizzle-session-repository-short-id.test.ts`
 * and `packages/domain/src/memory/memory-service.test.ts`) whose fake
 * `onConflictDoNothing` is a no-op passthrough — none of them can express
 * Postgres's own arbiter-inference rules, so the mismatch only surfaced live.
 * This file closes that gap by running the ACTUAL migration files against a
 * real Postgres container and exercising the ACTUAL
 * `DrizzleSessionRepository` / `MemoryService` production code paths.
 *
 * Two-level gate (mirrors postgres-pool-saturation.testcontainer.integration.test.ts):
 *   RUN_INTEGRATION_TESTS=1
 *   RUN_TESTCONTAINER_TESTS=1
 *
 * Run:
 *   RUN_INTEGRATION_TESTS=1 RUN_TESTCONTAINER_TESTS=1 \
 *     bun test --preload ./tests/setup.ts --timeout=180000 \
 *       tests/integration/short-id-conflict-inference.testcontainer.integration.test.ts
 *
 * Or: bun run test:integration:docker (adjust the script's file target, or
 * invoke this file directly as shown above).
 *
 * If the container fails to start with a "Log message ... Started ... not
 * received" error, that is testcontainers' own Ryuk reaper sidecar failing to
 * come up in time (a one-time per-process bootstrap, unrelated to the
 * no-op wait strategy below) — observed intermittently in a heavily-loaded
 * local Docker environment. Workaround: set `TESTCONTAINERS_RYUK_DISABLED=true`
 * (accepts the tradeoff of no auto-cleanup on an unclean process exit, fine
 * for an ephemeral local test run).
 *
 * @see mt#3005 — this file's originating task
 * @see mt#2966 / mt#2967 — the PRs whose tests missed this gap
 */

import { afterAll, describe, test, expect } from "bun:test";
import { GenericContainer, type WaitStrategy } from "testcontainers";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { join } from "path";
// Reading the actual shipped migrations/meta/_journal.json to drive the
// fresh-database bootstrap (mirrors production's own bootstrap path — see
// postgres-bootstrap.ts's header comment for why the linear 0000... tree
// cannot be replayed from empty). Not a mock-avoidance violation: this reads
// a real, committed artifact the same way the production bootstrap does.
// eslint-disable-next-line custom/no-real-fs-in-tests -- reads the real committed migration journal, mirroring production's own bootstrap path (postgres-bootstrap.ts), not test-state faking
import { readFileSync } from "fs";
import {
  resolvePgMigrationsFolder,
  type Journal,
} from "@minsky/domain/persistence/postgres-migration-operations";
import { bootstrapFreshPostgres } from "@minsky/domain/persistence/postgres-bootstrap";
import { DrizzleSessionRepository } from "@minsky/domain/session/drizzle-session-repository";
import type { SessionRecord } from "@minsky/domain/session/types";
import { MemoryService } from "@minsky/domain/memory/memory-service";
import { MemoryVectorStorage } from "@minsky/domain/storage/vector/memory-vector-storage";
import type { EmbeddingService } from "@minsky/domain/ai/embeddings/types";

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

// pgvector image: the memories/tasks/rules/etc. embeddings tables declare a
// `vector(...)` column type, so migrations replay needs the `vector`
// extension available (not auto-enabled by the image — we enable it
// ourselves below, mirroring how production Supabase has it enabled
// out-of-band of the migration tree, per grep across migrations/*.sql
// finding no in-tree `CREATE EXTENSION`).
const POSTGRES_IMAGE = "pgvector/pgvector:pg16";

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: overrides.sessionId ?? `sess-uuid-${Math.random().toString(36).slice(2)}`,
    repoName: "minsky",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function createTestEmbeddingService(dimension = 3): EmbeddingService {
  return {
    async generateEmbedding(text: string): Promise<number[]> {
      const hash = text.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
      return Array.from({ length: dimension }, (_, i) => Math.sin((hash + i) * 0.1));
    },
    async generateEmbeddings(texts: string[]): Promise<number[][]> {
      return Promise.all(texts.map((t) => this.generateEmbedding(t)));
    },
  };
}

if (process.env.RUN_INTEGRATION_TESTS && process.env.RUN_TESTCONTAINER_TESTS) {
  process.stdout.write(`[short-id-conflict/testcontainer] starting ${POSTGRES_IMAGE}\n`);

  let container;
  try {
    container = await new GenericContainer(POSTGRES_IMAGE)
      .withEnvironment({
        POSTGRES_PASSWORD: "postgres",
        POSTGRES_USER: "postgres",
        POSTGRES_DB: "postgres",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(makeNoOpWaitStrategy(120_000))
      .withStartupTimeout(120_000)
      .start();
  } catch (err) {
    process.stdout.write(
      `[short-id-conflict/testcontainer] container start FAILED: ${err instanceof Error ? err.message : String(err)}\n`
    );
    throw err;
  }

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const connectionString = `postgresql://postgres:postgres@${host}:${port}/postgres`;

  // SQL-level readiness probe (see sibling testcontainer file for rationale).
  // eslint-disable-next-line custom/no-real-fs-in-tests -- Date.now() used for a timing deadline, not path creation; the rule's BinaryExpression check produces a false positive here
  const probeDeadline = Date.now() + 60_000;
  let probeReady = false;
  // eslint-disable-next-line custom/no-real-fs-in-tests -- same false positive: Date.now() compared against a deadline variable, not used in path construction
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
      `[short-id-conflict/testcontainer] postgres readiness probe timed out after 60s at ${host}:${port}`
    );
  }

  process.stdout.write(`[short-id-conflict/testcontainer] container ready at ${host}:${port}\n`);

  const sql = postgres(connectionString, { prepare: false, max: 5 });

  // Enable the vector extension (not auto-enabled by the image; production
  // Supabase has it enabled out-of-band, per grep across migrations/*.sql
  // finding no in-tree CREATE EXTENSION), then bring the schema up to the
  // CURRENT state — including the mt#3005 fix (migration 0068) — the same
  // two-step way production bootstraps a fresh database (postgres-bootstrap.ts):
  // (1) apply the committed full-schema snapshot (the linear 0000... tree
  //     cannot be replayed from an empty database — 0000 is a literal empty
  //     baseline and 0001 immediately ALTERs tables a fresh DB doesn't have)
  //     and stamp the drizzle ledger through the snapshot's throughTag;
  // (2) run drizzle's own postgres-js migrator, which applies every journal
  //     entry newer than the stamped high-water-mark (0049..0068) — the
  //     exact mechanism production's MINSKY_AUTO_MIGRATE path uses.
  // This is exercised directly here, bypassing Minsky's CLI-only safety
  // guards (prod-connection / unmerged-migration checks) that don't apply to
  // an ephemeral local container.
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  const migrationsFolder = resolvePgMigrationsFolder();
  // eslint-disable-next-line custom/no-real-fs-in-tests -- reads the real committed migration journal, mirroring production's own bootstrap path (postgres-bootstrap.ts), not test-state faking
  const journalRaw = readFileSync(join(migrationsFolder, "meta", "_journal.json"), {
    encoding: "utf8",
  }) as string;
  const journal = JSON.parse(journalRaw) as Journal;
  const bootstrapResult = await bootstrapFreshPostgres(sql, migrationsFolder, journal);
  if (!bootstrapResult) {
    await container.stop().catch(() => {});
    throw new Error(
      `[short-id-conflict/testcontainer] no bootstrap snapshot found at ${migrationsFolder}/bootstrap — cannot set up test schema`
    );
  }
  const db = drizzle(sql);
  await migrate(db, { migrationsFolder });

  process.stdout.write(
    `[short-id-conflict/testcontainer] bootstrapped through ${bootstrapResult.throughTag}, ` +
      `migrations replayed through ${migrationsFolder}\n`
  );

  try {
    describe("short_id ON CONFLICT inference [testcontainer, real Postgres]", () => {
      afterAll(async () => {
        process.stdout.write(`[short-id-conflict/testcontainer] stopping container\n`);
        await sql.end().catch(() => {});
        await container.stop();
      });

      test("addSession mints ws#1 then ws#2 against real Postgres (mt#3005 fix: plain unique index)", async () => {
        const repo = new DrizzleSessionRepository(db as never);

        await repo.addSession(makeRecord({ sessionId: "mt3005-uuid-a" }));
        await repo.addSession(makeRecord({ sessionId: "mt3005-uuid-b" }));

        const sessionA = await repo.getSession("mt3005-uuid-a");
        const sessionB = await repo.getSession("mt3005-uuid-b");
        expect(sessionA?.shortId).toBe("ws#1");
        expect(sessionB?.shortId).toBe("ws#2");
      });

      test("MemoryService.create mints mem#1 then mem#2 against real Postgres (mt#3005 fix: plain unique index)", async () => {
        const embeddingService = createTestEmbeddingService();
        const vectorStorage = new MemoryVectorStorage(3);
        const service = new MemoryService({
          db: db as never,
          vectorStorage,
          embeddingService,
        });

        const first = await service.create({
          type: "reference",
          name: "mt3005-mem-a",
          description: "mt#3005 regression coverage",
          content: "first memory",
          scope: "project",
        });
        const second = await service.create({
          type: "reference",
          name: "mt3005-mem-b",
          description: "mt#3005 regression coverage",
          content: "second memory",
          scope: "project",
        });

        expect(first.shortId).toBe("mem#1");
        expect(second.shortId).toBe("mem#2");
      });

      test("REGRESSION: reintroducing a PARTIAL short_id index breaks addSession's ON CONFLICT inference (mt#3005 root cause)", async () => {
        // Recreate the exact broken form migrations 0066/0067 originally
        // shipped: a partial unique index with `WHERE short_id IS NOT NULL`.
        await sql`DROP INDEX "idx_sessions_short_id_unique"`;
        await sql`CREATE UNIQUE INDEX "idx_sessions_short_id_unique" ON "sessions" USING btree ("short_id") WHERE short_id IS NOT NULL`;

        const repo = new DrizzleSessionRepository(db as never);

        // addSession's insert uses a bare onConflictDoNothing({ target:
        // postgresSessions.shortId }) with no WHERE predicate — Postgres
        // cannot infer the partial index as an arbiter for a bare target,
        // so EVERY insert fails, not just colliding ones (matches the
        // production incident: "every session creation... fails"). Drizzle
        // wraps the real Postgres error in a DrizzleQueryError ("Failed
        // query: ...") with the actual Postgres message on `.cause` — walk
        // the cause chain so the assertion checks the real error text, not
        // just drizzle's wrapper message.
        let caught: unknown;
        try {
          await repo.addSession(makeRecord({ sessionId: "mt3005-regression-uuid" }));
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeDefined();
        const causeChainText = (() => {
          const parts: string[] = [];
          let current: unknown = caught;
          while (current instanceof Error) {
            parts.push(current.message);
            current = (current as { cause?: unknown }).cause;
          }
          return parts.join(" | ");
        })();
        expect(causeChainText).toMatch(/no unique or exclusion constraint matching/i);

        // Restore the plain (fixed) form so this test doesn't leave the
        // container in the broken state for any later assertions in this
        // file (defensive — this is currently the last test, but a plain
        // restore keeps the file order-independent).
        await sql`DROP INDEX "idx_sessions_short_id_unique"`;
        await sql`CREATE UNIQUE INDEX "idx_sessions_short_id_unique" ON "sessions" USING btree ("short_id")`;
      });
    });
  } catch (err) {
    process.stdout.write(
      `[short-id-conflict/testcontainer] suite registration failed; stopping container: ${err instanceof Error ? err.message : String(err)}\n`
    );
    await sql.end().catch(() => {});
    await container.stop().catch(() => {});
    throw err;
  }
} else {
  const missing: string[] = [];
  if (!process.env.RUN_INTEGRATION_TESTS) missing.push("RUN_INTEGRATION_TESTS=1");
  if (!process.env.RUN_TESTCONTAINER_TESTS) missing.push("RUN_TESTCONTAINER_TESTS=1");
  process.stdout.write(
    `[short-id-conflict/testcontainer] integration tests skipped — set ${missing.join(", ")} to run\n`
  );
}

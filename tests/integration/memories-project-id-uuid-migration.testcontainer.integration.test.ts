/**
 * memories.project_id text -> uuid migration — Testcontainers + real Postgres (mt#4668)
 *
 * `memories.project_id` was `text` with no foreign key while every sibling project-scoped
 * column (`tasks`, `sessions`, `asks`, `agent_transcripts`, …) is `uuid` with a FK to
 * `projects.id`. This closes that gap.
 *
 * The migration this file exists to verify (0112_marvelous_expediter.sql) carries a risk no
 * unit test can see: drizzle-kit 0.31.2 emits a BARE `SET DATA TYPE uuid` for a
 * non-enum->non-enum type change, and Postgres rejects a text->uuid `ALTER COLUMN` without an
 * explicit `USING` clause (`ERROR: column "project_id" cannot be cast automatically to type
 * uuid`). The generated file was hand-edited post-generation to add
 * `USING "project_id"::uuid` (mem#1314; precedent: 0013_slippery_grim_reaper.sql) — see that
 * file's own header comment for why this is not a hand-authored-migration violation (the
 * snapshot/journal bookkeeping stays generator-produced; only the SQL body gets the clause).
 *
 * This test reads and executes the ACTUAL committed migration file by path, not a copy of its
 * SQL embedded here — a future `bun run db:generate:pg` that silently regenerates over the
 * hand-added USING clause (or drops it) fails this test rather than shipping unnoticed.
 *
 * Deliberately NOT the whole-history bootstrap-then-replay pattern the sibling
 * short-id-conflict-inference test uses: this repo's bootstrap snapshot is regenerated
 * WHENEVER the schema changes (including by this same task), so a fresh bootstrap installs
 * `memories.project_id` as `uuid` directly and never exercises the `ALTER ... USING` cast at
 * all. Exercising the actual risky statement requires starting from the pre-migration TEXT
 * shape and applying 0112 on top of real data — a minimal two-table schema mirroring exactly
 * that BEFORE state, seeded with rows matching the verified prod shape (a NULL row for
 * user/cross_project scope, a row bound to a real project), then this migration's SQL applied
 * verbatim.
 *
 * Covers this task's acceptance tests directly:
 *   AT1 — join without a cast succeeds.
 *   AT2 — `information_schema` shows a FOREIGN KEY constraint memories -> projects.
 *   AT3 — inserting a memory whose project_id names no row in `projects` is rejected.
 *   AT4 — row count is preserved across the migration (including the NULL row).
 *
 * Two-level gate (mirrors postgres-pool-saturation.testcontainer.integration.test.ts):
 *   RUN_INTEGRATION_TESTS=1
 *   RUN_TESTCONTAINER_TESTS=1
 *
 * Run:
 *   RUN_INTEGRATION_TESTS=1 RUN_TESTCONTAINER_TESTS=1 \
 *     bun test --preload ./tests/setup.ts --timeout=120000 \
 *       tests/integration/memories-project-id-uuid-migration.testcontainer.integration.test.ts
 *
 * If the container fails to start with a "Log message ... Started ... not received" error,
 * that is testcontainers' own Ryuk reaper sidecar failing to come up in time — see the sibling
 * short-id-conflict-inference test's header comment for the workaround
 * (TESTCONTAINERS_RYUK_DISABLED=true).
 *
 * @see mt#4668 — this file's originating task
 * @see mem#1314 — the USING-clause hand-add precedent this migration follows
 * @see packages/domain/src/storage/migrations/pg/0112_marvelous_expediter.sql
 * @see packages/domain/src/storage/migrations/pg/0013_slippery_grim_reaper.sql — prior art
 */

import { afterAll, describe, test, expect } from "bun:test";
import { GenericContainer, type WaitStrategy } from "testcontainers";
import postgres from "postgres";
import { join } from "path";
// eslint-disable-next-line custom/no-real-fs-in-tests -- reads the real committed migration file, mirroring production's own bootstrap path (postgres-bootstrap.ts), not test-state faking
import { readFileSync } from "fs";
import { resolvePgMigrationsFolder } from "@minsky/domain/persistence/postgres-migration-operations";

// No-op wait strategy — see postgres-pool-saturation.testcontainer.integration.test.ts for the
// full rationale (every built-in testcontainers wait strategy hangs under Bun; readiness is
// determined by our own SQL probe instead).
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

// Reuse the pgvector image the sibling testcontainer tests already pull — this file has no
// vector-column need of its own, but sharing the image keeps local/CI Docker caching warm
// rather than pulling a second base image just for this suite.
const POSTGRES_IMAGE = "pgvector/pgvector:pg16";

const MIGRATION_FILE = "0112_marvelous_expediter.sql";
const ORPHAN_PROJECT_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Narrow `rows[0]` to a defined row without a `!` non-null assertion (project convention:
 * proper narrowing over silencing). Throws — surfacing as a clear test failure — rather than
 * letting an empty result set produce a silent `undefined` property read further down.
 */
function firstRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("expected at least one row, got zero");
  }
  return row;
}

if (process.env.RUN_INTEGRATION_TESTS && process.env.RUN_TESTCONTAINER_TESTS) {
  process.stdout.write(`[memories-project-id-uuid/testcontainer] starting ${POSTGRES_IMAGE}\n`);

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
      `[memories-project-id-uuid/testcontainer] container start FAILED: ${err instanceof Error ? err.message : String(err)}\n`
    );
    throw err;
  }

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const connectionString = `postgresql://postgres:postgres@${host}:${port}/postgres`;

  // SQL-level readiness probe (see sibling testcontainer file for rationale).
  // eslint-disable-next-line custom/no-real-fs-in-tests -- Date.now() used for a timing deadline, not path creation; the rule's BinaryExpression check false-positives here
  const probeDeadline = Date.now() + 60_000;
  let probeReady = false;
  // eslint-disable-next-line custom/no-real-fs-in-tests -- same false positive as above
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
      `[memories-project-id-uuid/testcontainer] postgres readiness probe timed out after 60s at ${host}:${port}`
    );
  }

  process.stdout.write(
    `[memories-project-id-uuid/testcontainer] container ready at ${host}:${port}\n`
  );

  const sql = postgres(connectionString, { prepare: false, max: 5 });

  try {
    describe("memories.project_id text->uuid migration [testcontainer, real Postgres]", () => {
      afterAll(async () => {
        process.stdout.write(`[memories-project-id-uuid/testcontainer] stopping container\n`);
        await sql.end().catch(() => {});
        await container.stop();
      });

      test("0112 converts project_id to uuid, adds the FK, and preserves every row (AT1-AT4)", async () => {
        // Minimal PRE-migration shape: exactly the two columns this migration touches, on a
        // `memories` table with a plain-text `project_id` and no FK — the real BEFORE state,
        // not a paraphrase of it. The real table's other columns (type, scope, etc.) are
        // irrelevant to this migration's own SQL, which names only `project_id`.
        await sql`CREATE TABLE projects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text)`;
        await sql`CREATE TABLE memories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id text)`;

        const projRows =
          await sql`INSERT INTO projects (slug) VALUES ('edobry/minsky') RETURNING id`;
        const projectId = firstRow(projRows)["id"] as string;

        // Seed matching the verified prod shape from planning (2026-08-27): a row bound to a
        // real project (well-formed uuid-shaped TEXT) and a NULL row (the by-design
        // user/cross_project shape — ADR-021 explicitly keeps these unbackfilled).
        await sql`INSERT INTO memories (project_id) VALUES (${projectId})`;
        await sql`INSERT INTO memories (project_id) VALUES (NULL)`;

        const preCount = await sql`SELECT COUNT(*)::int AS n FROM memories`;
        expect(firstRow(preCount)["n"]).toBe(2);

        // Apply the ACTUAL generated-and-hand-edited migration file, verbatim — this is what
        // proves the USING clause is present in the shipped artifact, not just in this test's
        // idea of what it should say.
        const migrationsFolder = resolvePgMigrationsFolder();
        // eslint-disable-next-line custom/no-real-fs-in-tests -- reads the real committed migration file, mirroring production's own bootstrap path (postgres-bootstrap.ts), not test-state faking
        const migrationSql = readFileSync(join(migrationsFolder, MIGRATION_FILE), {
          encoding: "utf8",
        }) as string;
        const statements = migrationSql
          .split("--> statement-breakpoint")
          .map((s) => s.trim())
          .filter(Boolean);
        expect(statements.length).toBeGreaterThanOrEqual(2); // ALTER TYPE + ADD CONSTRAINT
        for (const stmt of statements) {
          await sql.unsafe(stmt);
        }

        // AT4: row count preserved across the migration.
        const postCount = await sql`SELECT COUNT(*)::int AS n FROM memories`;
        expect(firstRow(postCount)["n"]).toBe(2);

        // The NULL row specifically survives the USING cast (NULL::uuid is NULL, not an error).
        const nullCount =
          await sql`SELECT COUNT(*)::int AS n FROM memories WHERE project_id IS NULL`;
        expect(firstRow(nullCount)["n"]).toBe(1);

        // The column is now uuid.
        const colType = await sql`
          SELECT data_type FROM information_schema.columns
          WHERE table_name = 'memories' AND column_name = 'project_id'
        `;
        expect(firstRow(colType)["data_type"]).toBe("uuid");

        // AT1: join without a cast.
        const joined = await sql`
          SELECT COUNT(*)::int AS n FROM memories m JOIN projects p ON m.project_id = p.id
        `;
        expect(firstRow(joined)["n"]).toBe(1);

        // AT2: FK constraint exists, memories.project_id -> projects.id.
        const fk = await sql`
          SELECT COUNT(*)::int AS n
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          JOIN information_schema.referential_constraints rc
            ON tc.constraint_name = rc.constraint_name
            AND tc.table_schema = rc.constraint_schema
          JOIN information_schema.table_constraints tc2
            ON rc.unique_constraint_name = tc2.constraint_name
            AND rc.unique_constraint_schema = tc2.table_schema
          WHERE tc.table_schema = 'public'
            AND tc.table_name = 'memories'
            AND tc.constraint_type = 'FOREIGN KEY'
            AND kcu.column_name = 'project_id'
            AND tc2.table_name = 'projects'
        `;
        expect(firstRow(fk)["n"]).toBeGreaterThanOrEqual(1);

        // AT3: inserting a memory whose project_id names no row in `projects` is rejected.
        let caught: unknown;
        try {
          await sql`INSERT INTO memories (project_id) VALUES (${ORPHAN_PROJECT_ID})`;
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeDefined();
        // Assert on the stable Postgres SQLSTATE (23503 — foreign_key_violation) rather than
        // message text, matching the sibling testcontainer test's convention.
        expect((caught as { code?: string })?.code).toBe("23503");
      });
    });
  } catch (err) {
    process.stdout.write(
      `[memories-project-id-uuid/testcontainer] suite registration failed; stopping container: ${err instanceof Error ? err.message : String(err)}\n`
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
    `[memories-project-id-uuid/testcontainer] integration tests skipped — set ${missing.join(", ")} to run\n`
  );
}

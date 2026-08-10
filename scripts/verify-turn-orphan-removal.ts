#!/usr/bin/env bun
/**
 * Live verification for turn-writer's orphan removal and chunk sizing
 * (mt#3514, mt#3911).
 *
 * **Why this exists as a script rather than a unit test.** The unit tests use
 * an in-memory fake that deliberately does NOT evaluate the drizzle predicate
 * `and(eq(session), gte(turn_index, N))` — simulating Postgres's WHERE
 * evaluation in a fake would be pretending to implement the database, and a
 * test that passes against that pretence is evidence about the fake. The same
 * goes for the failure this script's sibling task was filed for: a chunk
 * exceeding the server's `statement_timeout` is a property of a real Postgres
 * under real row widths and real index maintenance, and no fake can exhibit
 * it. So the row selection and the write's timing behavior are verified HERE,
 * against the live database.
 *
 * `turn-writer.test.ts` has cited this path since mt#3514. It did not exist
 * until mt#3911 — the citation was to an artifact nobody wrote, which is a
 * near-relative of the defect mt#3911 fixes (a claimed check that was never
 * actually looking). Had it existed and been run, the partial-write failure
 * would have surfaced on the first large session instead of via a corpus-wide
 * duplicate-row audit weeks later.
 *
 * Usage:
 *   bun scripts/verify-turn-orphan-removal.ts
 *   bun scripts/verify-turn-orphan-removal.ts --session <conversation-uuid>
 *
 * Exits 0 on pass, 1 on failure, and 0 with a SKIP notice when no Postgres
 * connection is configured (so it is safe in an environment without DB creds).
 *
 * The write it performs is the ordinary, idempotent extraction reconciliation
 * — the same one `transcripts index-embeddings --conversation-id <id>` runs.
 *
 * @see packages/domain/src/transcripts/turn-writer.ts
 * @see docs/architecture/adr-019-transcript-pipeline-staging.md
 */

import "reflect-metadata";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";

/**
 * Default subject: the session whose partial write surfaced mt#3911. It
 * extracts to 604 turns and, before the fix, wrote only 104 of them because
 * its first 500-row chunk exceeded the 30s statement timeout.
 */
const DEFAULT_SESSION = "d4335f47-eb8f-4dc5-8ecb-668a6fdd0e3c";

interface Counts {
  total: number;
  atOrAboveBound: number;
}

function parseSession(argv: string[]): string {
  const idx = argv.indexOf("--session");
  if (idx >= 0) {
    const value = argv[idx + 1];
    if (!value) throw new Error("--session requires a conversation id");
    return value;
  }
  return DEFAULT_SESSION;
}

async function bootstrapDb(): Promise<PostgresJsDatabase | null> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");

  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });
  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  interface SqlCapablePersistence {
    getDatabaseConnection: () => Promise<PostgresJsDatabase | null>;
  }
  // Duck-typed (mirrors scripts/backfill-agent-transcript-turns.ts): an
  // `instanceof` against a dynamically imported class false-negatives under
  // the dual-package hazard.
  const isSqlCapable = (p: unknown): p is SqlCapablePersistence =>
    !!p &&
    !!(p as { capabilities?: { sql?: boolean } }).capabilities?.sql &&
    typeof (p as { getDatabaseConnection?: unknown }).getDatabaseConnection === "function";

  if (!isSqlCapable(persistence)) return null;
  return persistence.getDatabaseConnection();
}

async function countRows(db: PostgresJsDatabase, session: string, bound: number): Promise<Counts> {
  // Narrowed at runtime rather than via a double assertion, matching
  // scripts/backfill-agent-transcript-turns.ts: drizzle's `execute` is
  // untyped, and `as unknown as <shape>` would assert a shape nothing checks.
  const rows = (await db.execute(sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE turn_index >= ${bound})::int AS at_or_above
    FROM agent_transcript_turns
    WHERE agent_session_id = ${session}
  `)) as Array<Record<string, unknown>>;
  return {
    total: Number(rows[0]?.total ?? 0),
    atOrAboveBound: Number(rows[0]?.at_or_above ?? 0),
  };
}

async function main(): Promise<void> {
  const session = parseSession(process.argv.slice(2));

  let db: PostgresJsDatabase | null = null;
  try {
    db = await bootstrapDb();
  } catch (err) {
    console.log(`SKIP: could not initialize persistence (${(err as Error).message})`);
    process.exit(0);
  }
  if (!db) {
    console.log("SKIP: no SQL-capable persistence provider configured.");
    process.exit(0);
  }

  const { extractTurns } = await import("@minsky/domain/transcripts/turn-extractor");
  const { writeTurnsForTranscript } = await import("@minsky/domain/transcripts/turn-writer");

  const transcriptRows = (await db.execute(sql`
    SELECT transcript FROM agent_transcripts WHERE agent_session_id = ${session}
  `)) as Array<Record<string, unknown>>;

  if (transcriptRows.length === 0) {
    console.log(`FAIL: no agent_transcripts row for session ${session}`);
    process.exit(1);
  }

  const transcript = transcriptRows[0]?.transcript;
  const expectedTurns = extractTurns(transcript as never).length;
  const before = await countRows(db, session, expectedTurns);

  const started = performance.now();
  const result = await writeTurnsForTranscript(db, session, transcript);
  const elapsedMs = Math.round(performance.now() - started);

  const after = await countRows(db, session, expectedTurns);

  const failures: string[] = [];
  if (result.extracted !== expectedTurns) {
    failures.push(`result.extracted ${result.extracted} != extractor's ${expectedTurns}`);
  }
  if (result.erroredChunks !== 0) {
    failures.push(`erroredChunks = ${result.erroredChunks} (expected 0)`);
  }
  if (result.written !== expectedTurns) {
    failures.push(`written ${result.written} != extracted ${expectedTurns} — partial write`);
  }
  if (result.orphanDeleteFailed) {
    failures.push("orphanDeleteFailed = true");
  }
  // The property the in-memory fake structurally cannot check: the DELETE's
  // predicate actually selected the right rows in Postgres.
  if (after.atOrAboveBound !== 0) {
    failures.push(`${after.atOrAboveBound} row(s) remain at turn_index >= ${expectedTurns}`);
  }
  if (after.total !== expectedTurns) {
    failures.push(`session holds ${after.total} rows, expected exactly ${expectedTurns}`);
  }

  const report = {
    session,
    expectedTurns,
    rowsBefore: before.total,
    orphansBefore: before.atOrAboveBound,
    rowsAfter: after.total,
    orphansAfter: after.atOrAboveBound,
    written: result.written,
    extracted: result.extracted,
    erroredChunks: result.erroredChunks,
    chunkSplits: result.chunkSplits,
    orphansDeleted: result.orphansDeleted,
    orphanDeleteFailed: result.orphanDeleteFailed,
    elapsedMs,
    verdict: failures.length === 0 ? "PASS" : "FAIL",
  };
  console.log(JSON.stringify(report, null, 2));

  if (failures.length > 0) {
    for (const f of failures) console.log(`FAIL: ${f}`);
    process.exit(1);
  }
  console.log("PASS: every extracted turn is written and no row survives past the bound.");
  process.exit(0);
}

void main();

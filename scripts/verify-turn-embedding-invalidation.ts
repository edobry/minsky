#!/usr/bin/env bun
/**
 * Live verification for turn-writer's CONDITIONAL embedding preservation
 * (mt#3883).
 *
 * **Why this exists as a script rather than a unit test.** The behavior under
 * test is a `CASE ... IS DISTINCT FROM ... THEN NULL ELSE embedding END`
 * expression inside an `ON CONFLICT DO UPDATE` SET clause. `turn-writer.test.ts`
 * drives an in-memory fake that only ever receives the `values` array — it never
 * sees a SET clause at all, so it structurally cannot exhibit this. Simulating
 * the CASE in the fake would be pretending to implement Postgres, and a test
 * that passes against that pretence is evidence about the fake, not the query.
 * That is the same split the fake's orphan-delete seam already documents.
 *
 * **What it proves.** Two halves, and the second is the one mt#3883 added:
 *
 *   1. Re-writing a turn whose TEXT is unchanged PRESERVES its vector. This is
 *      ADR-019's embedding-preservation invariant and must not regress — the
 *      capture path runs constantly over already-embedded rows.
 *   2. Re-writing a turn whose TEXT changed NULLS its vector. Without this, a
 *      moved turn boundary (exactly what mt#3883's fusion fix does, for 23.3% of
 *      conversations) leaves the row holding an embedding that describes content
 *      it no longer has — semantic search then returns it confidently for the
 *      wrong query, with no error anywhere to notice.
 *
 * Usage:
 *   bun scripts/verify-turn-embedding-invalidation.ts
 *
 * Exits 0 on pass, 1 on failure, and 0 with a SKIP notice when no Postgres
 * connection is configured (safe in an environment without DB creds).
 *
 * **Blast radius.** It writes ONE scratch `agent_transcripts` row plus its turn
 * rows, under a fixed, obviously-synthetic conversation id, and deletes them in
 * a `finally`. It never touches a real conversation. A leftover from an
 * interrupted run is cleaned up by the next run before it starts.
 *
 * @see packages/domain/src/transcripts/turn-writer.ts — the SET clause
 * @see scripts/verify-turn-orphan-removal.ts — the sibling this follows
 * @see docs/architecture/adr-019-transcript-pipeline-staging.md
 */

import "reflect-metadata";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";

import type { RawTurnLine } from "@minsky/domain/transcripts/transcript-source";

/**
 * Fixed, obviously-synthetic subject. The `3883` group makes its origin
 * greppable if a run is ever interrupted before cleanup.
 */
const SCRATCH_SESSION = "00000000-3883-4000-8000-000000000001";

const EMBEDDING_DIMENSIONS = 1536;

function transcriptWith(assistantText: string): RawTurnLine[] {
  return [
    {
      type: "user",
      timestamp: "2026-01-01T10:00:00.000Z",
      message: { role: "user", content: "scratch prompt" },
    },
    {
      type: "assistant",
      timestamp: "2026-01-01T10:00:01.000Z",
      message: {
        role: "assistant",
        id: "msg_scratch_a",
        content: [{ type: "text", text: assistantText }],
      },
    },
  ];
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
  // Duck-typed (mirrors verify-turn-orphan-removal.ts): an `instanceof` against
  // a dynamically imported class false-negatives under bun's module resolution.
  const candidate = persistence as SqlCapablePersistence | undefined;
  if (!candidate || typeof candidate.getDatabaseConnection !== "function") return null;
  return await candidate.getDatabaseConnection();
}

async function removeScratchRows(db: PostgresJsDatabase): Promise<void> {
  await db.execute(
    sql`DELETE FROM agent_transcript_turns WHERE agent_session_id = ${SCRATCH_SESSION}`
  );
  await db.execute(sql`DELETE FROM agent_transcripts WHERE agent_session_id = ${SCRATCH_SESSION}`);
}

async function readEmbeddingIsNull(db: PostgresJsDatabase): Promise<boolean> {
  // A single assertion to a permissive shape, matching verify-turn-orphan-removal.ts:
  // drizzle's `execute` is untyped here, and `as unknown as <exact shape>` would
  // assert a shape nothing actually checks.
  const rows = (await db.execute(
    sql`SELECT embedding IS NULL AS is_null
        FROM agent_transcript_turns
        WHERE agent_session_id = ${SCRATCH_SESSION} AND turn_index = 0`
  )) as Array<Record<string, unknown>>;

  const row = rows[0];
  if (!row) throw new Error("scratch turn row 0 not found — the write did not land");
  return row["is_null"] === true;
}

async function main(): Promise<number> {
  const db = await bootstrapDb();
  if (!db) {
    console.log("SKIP: no Postgres connection configured — nothing to verify against.");
    return 0;
  }

  const { writeTurnsForTranscript } = await import("@minsky/domain/transcripts/turn-writer");

  try {
    await removeScratchRows(db);

    await db.execute(
      sql`INSERT INTO agent_transcripts (agent_session_id, harness)
          VALUES (${SCRATCH_SESSION}, 'verification-scratch')`
    );

    // 1. Materialize the turn.
    const first = await writeTurnsForTranscript(db, SCRATCH_SESSION, transcriptWith("original"));
    if (first.written !== 1) {
      console.error(`FAIL: expected 1 turn written, got ${first.written}`);
      return 1;
    }

    // 2. Give it a vector, the way the embedding backfill would.
    await db.execute(
      sql`UPDATE agent_transcript_turns
          SET embedding = (
            SELECT ('[' || string_agg('0.001', ',') || ']')::vector
            FROM generate_series(1, ${EMBEDDING_DIMENSIONS})
          )
          WHERE agent_session_id = ${SCRATCH_SESSION} AND turn_index = 0`
    );
    if (await readEmbeddingIsNull(db)) {
      console.error("FAIL: setup did not attach an embedding — the rest proves nothing.");
      return 1;
    }

    // 3. Re-write with IDENTICAL text — the vector must survive (ADR-019).
    await writeTurnsForTranscript(db, SCRATCH_SESSION, transcriptWith("original"));
    if (await readEmbeddingIsNull(db)) {
      console.error(
        "FAIL: re-writing unchanged text NULLED the embedding. ADR-019's preservation " +
          "invariant is broken — every capture-path write would now discard vectors."
      );
      return 1;
    }
    console.log("PASS: unchanged text preserved the embedding.");

    // 4. Re-write with CHANGED text — the vector must be discarded (mt#3883).
    await writeTurnsForTranscript(
      db,
      SCRATCH_SESSION,
      transcriptWith("changed by a moved boundary")
    );
    if (!(await readEmbeddingIsNull(db))) {
      console.error(
        "FAIL: changed text KEPT the embedding. The row now holds a vector describing " +
          "content it no longer has — semantic search will return it for the wrong query."
      );
      return 1;
    }
    console.log("PASS: changed text invalidated the embedding.");

    console.log("\nverify-turn-embedding-invalidation: PASS (2/2)");
    return 0;
  } finally {
    await removeScratchRows(db);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("verify-turn-embedding-invalidation: ERROR", err);
    process.exit(1);
  });

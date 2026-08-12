#!/usr/bin/env bun
/**
 * Live verification for ToolCallProjectionPipeline's orphan removal (mt#3978).
 *
 * **Why this exists as a script rather than a unit test.** The behavior under
 * test is a DELETE whose predicate is an anti-join against
 * `agent_transcript_turns`, including `jsonb_array_length(t.tool_calls)`.
 * `tool-call-projection-pipeline.test.ts` drives an in-memory fake that does not
 * evaluate drizzle's `sql` chunks at all — simulating the predicate there would
 * be pretending to implement Postgres, and a test passing against that pretence
 * is evidence about the fake. So the unit tests own the ORCHESTRATION (is the
 * delete issued, when is it skipped, do its outcomes reach the counters) and
 * this script owns the ROW SELECTION, against the real database. Same split
 * `verify-turn-orphan-removal.ts` records for mt#3514.
 *
 * **What it proves.** Three things, in one scratch conversation:
 *
 *   1. A projection row whose whole TURN no longer exists is deleted. This is
 *      the measured corpus backlog's shape: 17,044 rows across 199
 *      conversations, all beyond their conversation's current max `turn_index`,
 *      left behind when mt#3902 removed stale turn rows underneath them.
 *   2. A projection row at an ORDINAL past a surviving turn's current tool-call
 *      count is deleted. The corpus query cannot see this class at all — it only
 *      counts orphans whose whole turn vanished — so a bound like mt#3514's
 *      `turn_index >= N` would silently leave it behind. This is the case that
 *      justifies the anti-join over an index bound.
 *   3. A turn whose `tool_calls` is the double-encoded jsonb STRING shape
 *      (mt#3360) keeps its rows, while a genuine orphan beside it still goes.
 *      That shape IS a jsonb type distinction, so only the real database can
 *      exhibit it — the in-memory fake has no jsonb, which is how the case
 *      reached review uncovered (PR #2887 R1).
 *   4. Rows the current derivation DOES emit survive, and a session with no turn
 *      rows keeps its whole projection (the zero-yield safety guard, live).
 *
 * Usage:
 *   bun scripts/verify-projection-orphan-removal.ts
 *
 * Exits 0 on pass, 1 on failure, and 0 with a SKIP notice when no Postgres
 * connection is configured (safe in an environment without DB creds).
 *
 * **Blast radius.** It writes ONE scratch `agent_transcripts` row plus its turn
 * and projection rows, under a fixed, obviously-synthetic conversation id, and
 * deletes them in a `finally`. It never touches a real conversation. A leftover
 * from an interrupted run is cleaned up by the next run before it starts.
 *
 * @see packages/domain/src/transcripts/tool-call-projection-pipeline.ts
 * @see scripts/verify-turn-orphan-removal.ts — the sibling this follows
 */

import "reflect-metadata";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";

import type { RawTurnLine } from "@minsky/domain/transcripts/transcript-source";

/**
 * Fixed, obviously-synthetic subject. The `3978` group makes its origin
 * greppable if a run is ever interrupted before cleanup.
 */
const SCRATCH_SESSION = "00000000-3978-4000-8000-000000000001";

/**
 * Two turns: the first carrying 2 tool calls, the second 1 — so the projection
 * has keys (0,0), (0,1), (1,0), and an orphan at (0,2) is an ordinal one past
 * turn 0's real count.
 */
// No cast needed on either helper: `RawTurnLine.message` is `unknown` and the
// interface carries a pass-through index signature, so a well-shaped literal
// satisfies it directly.
function userLine(timestamp: string, text: string): RawTurnLine {
  return {
    type: "user",
    timestamp,
    message: { role: "user", content: text },
  };
}

function assistantLineWithTools(
  timestamp: string,
  id: string,
  blocks: Array<{ type: string; name: string; input: unknown }>
): RawTurnLine {
  return {
    type: "assistant",
    timestamp,
    message: { role: "assistant", id, content: blocks },
  };
}

function scratchTranscript(): RawTurnLine[] {
  return [
    userLine("2026-01-01T10:00:00.000Z", "read two files"),
    assistantLineWithTools("2026-01-01T10:00:01.000Z", "msg_scratch_a", [
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", name: "mcp__minsky__session_read_file", input: { path: "/x" } },
    ]),
    userLine("2026-01-01T10:01:00.000Z", "now run the tests"),
    assistantLineWithTools("2026-01-01T10:01:01.000Z", "msg_scratch_b", [
      { type: "tool_use", name: "Bash", input: { command: "bun test" } },
    ]),
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
  // Projection first: it holds the FK to agent_transcripts.
  await db.execute(
    sql`DELETE FROM agent_tool_call_projection WHERE agent_session_id = ${SCRATCH_SESSION}`
  );
  await db.execute(
    sql`DELETE FROM agent_transcript_turns WHERE agent_session_id = ${SCRATCH_SESSION}`
  );
  await db.execute(sql`DELETE FROM agent_transcripts WHERE agent_session_id = ${SCRATCH_SESSION}`);
}

/** Every projection key for the scratch session, as `turn_index:ordinal`, ordered. */
async function readProjectionKeys(db: PostgresJsDatabase): Promise<string[]> {
  // A single assertion to a permissive shape, matching verify-turn-orphan-removal.ts:
  // drizzle's `execute` is untyped here, and `as unknown as <exact shape>` would
  // assert a shape nothing actually checks.
  const rows = (await db.execute(
    sql`SELECT turn_index, ordinal
        FROM agent_tool_call_projection
        WHERE agent_session_id = ${SCRATCH_SESSION}
        ORDER BY turn_index, ordinal`
  )) as Array<Record<string, unknown>>;

  return rows.map((r) => `${String(r["turn_index"])}:${String(r["ordinal"])}`);
}

/** Insert a projection row directly — standing in for one an earlier derivation wrote. */
async function seedProjectionRow(
  db: PostgresJsDatabase,
  turnIndex: number,
  ordinal: number
): Promise<void> {
  await db.execute(
    sql`INSERT INTO agent_tool_call_projection
          (agent_session_id, turn_index, ordinal, tool_name, server, arg_fingerprint, timestamp)
        VALUES (${SCRATCH_SESSION}, ${turnIndex}, ${ordinal}, 'StaleTool', NULL, 'stale-fingerprint', NULL)
        ON CONFLICT (agent_session_id, turn_index, ordinal) DO NOTHING`
  );
}

async function main(): Promise<number> {
  const db = await bootstrapDb();
  if (!db) {
    console.log("SKIP: no Postgres connection configured — nothing to verify against.");
    return 0;
  }

  const { writeTurnsForTranscript } = await import("@minsky/domain/transcripts/turn-writer");
  const { ToolCallProjectionPipeline } = await import(
    "@minsky/domain/transcripts/tool-call-projection-pipeline"
  );
  const pipeline = new ToolCallProjectionPipeline(db);

  try {
    await removeScratchRows(db);

    await db.execute(
      sql`INSERT INTO agent_transcripts (agent_session_id, harness)
          VALUES (${SCRATCH_SESSION}, 'verification-scratch')`
    );

    // 1. Materialize turns, then derive the projection from them.
    const write = await writeTurnsForTranscript(db, SCRATCH_SESSION, scratchTranscript());
    if (write.written !== 2) {
      console.error(`FAIL: expected 2 turns written, got ${write.written}`);
      return 1;
    }

    const firstRun = await pipeline.runForSession(SCRATCH_SESSION);
    const baseline = await readProjectionKeys(db);
    const EXPECTED_LIVE = ["0:0", "0:1", "1:0"];
    if (baseline.join(",") !== EXPECTED_LIVE.join(",")) {
      console.error(
        `FAIL: baseline projection is ${baseline.join(", ") || "(empty)"}, ` +
          `expected ${EXPECTED_LIVE.join(", ")} — the rest proves nothing.`
      );
      return 1;
    }
    if (firstRun.orphanDeleteFailed) {
      console.error("FAIL: the baseline run reported orphanDeleteFailed.");
      return 1;
    }

    // 2. Seed both orphan classes, the way an earlier derivation would have left
    //    them: a row for a turn that no longer exists, and a row at an ordinal
    //    past a surviving turn's current tool-call count.
    await seedProjectionRow(db, 5, 0); // vanished turn
    await seedProjectionRow(db, 0, 2); // ordinal past turn 0's 2 tool calls
    const seeded = await readProjectionKeys(db);
    if (seeded.length !== 5) {
      console.error(`FAIL: expected 5 rows after seeding, got ${seeded.length}`);
      return 1;
    }

    // 3. Re-derive: both orphans must go, and only they.
    const second = await pipeline.runForSession(SCRATCH_SESSION);
    const afterCleanup = await readProjectionKeys(db);

    if (second.orphanDeleteFailed) {
      console.error("FAIL: orphanDeleteFailed = true on the re-derivation run.");
      return 1;
    }
    if (second.orphansDeleted !== 2) {
      console.error(`FAIL: orphansDeleted = ${second.orphansDeleted}, expected 2`);
      return 1;
    }
    if (afterCleanup.join(",") !== EXPECTED_LIVE.join(",")) {
      console.error(
        `FAIL: projection is ${afterCleanup.join(", ") || "(empty)"} after cleanup, ` +
          `expected exactly the live keys ${EXPECTED_LIVE.join(", ")}.`
      );
      return 1;
    }
    console.log(
      "PASS: both orphan classes removed (vanished turn 5:0, past-count ordinal 0:2); " +
        `live keys ${EXPECTED_LIVE.join(", ")} survived.`
    );

    // 4. An UNREADABLE turn's rows are protected, live (PR #2887 R1). A turn
    //    whose `tool_calls` is the double-encoded jsonb STRING shape (mt#3360)
    //    is filtered out of the derivation's SELECT entirely, so on the
    //    live-slot predicate alone every row it owns reads as an orphan. Only
    //    the real database can exhibit this: the shape IS a jsonb type
    //    distinction, and the in-memory fake has no jsonb.
    await db.execute(
      sql`INSERT INTO agent_transcript_turns (agent_session_id, turn_index, tool_calls)
          VALUES (${SCRATCH_SESSION}, 7, to_jsonb('[{"type":"tool_use","name":"Bash"}]'::text))`
    );
    const unreadableShape = (await db.execute(
      sql`SELECT jsonb_typeof(tool_calls) AS shape
          FROM agent_transcript_turns
          WHERE agent_session_id = ${SCRATCH_SESSION} AND turn_index = 7`
    )) as Array<Record<string, unknown>>;
    if (unreadableShape[0]?.["shape"] !== "string") {
      console.error(
        `FAIL: setup wrote turn 7 as jsonb '${String(unreadableShape[0]?.["shape"])}', ` +
          `expected 'string' — the double-encoded shape was not reproduced, so this proves nothing.`
      );
      return 1;
    }
    await seedProjectionRow(db, 7, 0); // owned by the unreadable turn
    await seedProjectionRow(db, 7, 1);
    await seedProjectionRow(db, 8, 0); // a genuine orphan alongside it

    const fourth = await pipeline.runForSession(SCRATCH_SESSION);
    const afterUnreadable = await readProjectionKeys(db);
    const EXPECTED_WITH_UNREADABLE = [...EXPECTED_LIVE, "7:0", "7:1"];

    if (fourth.skippedNonArray !== 1) {
      console.error(`FAIL: skippedNonArray = ${fourth.skippedNonArray}, expected 1`);
      return 1;
    }
    if (fourth.orphansDeleted !== 1) {
      console.error(
        `FAIL: orphansDeleted = ${fourth.orphansDeleted}, expected 1 — only the genuine ` +
          `orphan at 8:0 should go, and the unreadable turn's rows should stay.`
      );
      return 1;
    }
    if (afterUnreadable.join(",") !== EXPECTED_WITH_UNREADABLE.join(",")) {
      console.error(
        `FAIL: projection is ${afterUnreadable.join(", ") || "(empty)"}, ` +
          `expected ${EXPECTED_WITH_UNREADABLE.join(", ")} — an unreadable turn's rows were ` +
          `deleted as if the turn did not exist.`
      );
      return 1;
    }
    console.log(
      "PASS: an unreadable (double-encoded) turn kept its rows while the genuine orphan 8:0 was removed."
    );

    // Restore the baseline for the next check.
    await db.execute(
      sql`DELETE FROM agent_tool_call_projection
          WHERE agent_session_id = ${SCRATCH_SESSION} AND turn_index = 7`
    );

    // 5. Zero-yield safety guard, live: with the turn rows gone (an upstream gap,
    //    not a derivation result), the projection must be left alone.
    await db.execute(
      sql`DELETE FROM agent_transcript_turns WHERE agent_session_id = ${SCRATCH_SESSION}`
    );
    const third = await pipeline.runForSession(SCRATCH_SESSION);
    const afterGuard = await readProjectionKeys(db);

    if (third.orphansDeleted !== 0 || third.orphanDeleteFailed) {
      console.error(
        `FAIL: the no-turn-rows run deleted ${third.orphansDeleted} row(s) ` +
          `(orphanDeleteFailed=${third.orphanDeleteFailed}); it must delete nothing.`
      );
      return 1;
    }
    if (afterGuard.join(",") !== EXPECTED_LIVE.join(",")) {
      console.error(
        `FAIL: a session with no turn rows lost projection rows — ` +
          `${afterGuard.join(", ") || "(empty)"} remains, expected ${EXPECTED_LIVE.join(", ")}.`
      );
      return 1;
    }
    console.log("PASS: a session with no turn rows kept its whole projection.");

    console.log("\nverify-projection-orphan-removal: PASS (4/4)");
    return 0;
  } finally {
    await removeScratchRows(db);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("verify-projection-orphan-removal: ERROR", err);
    process.exit(1);
  });

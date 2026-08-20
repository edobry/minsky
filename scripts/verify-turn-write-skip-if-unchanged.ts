#!/usr/bin/env bun
/**
 * Live verification for turn-writer's skip-if-unchanged upsert guard
 * (mt#4345).
 *
 * **Why this exists as a script rather than a unit test.** The behavior under
 * test is a `setWhere` predicate on an `ON CONFLICT DO UPDATE` — Postgres skips
 * the write entirely when the predicate is false. `turn-writer.test.ts` drives
 * an in-memory fake whose `onConflictDoUpdate(_opts)` ignores `_opts` and always
 * applies the write; it structurally cannot exhibit "did Postgres actually skip
 * this row." That is the same split `turn-writer.test.ts` already documents for
 * the mt#3883 embedding CASE expression, and this script follows
 * `verify-turn-embedding-invalidation.ts`'s pattern directly.
 *
 * **What it proves**, matching the mt#4345 spec's four acceptance tests:
 *
 *   1. Re-ingesting an IDENTICAL transcript rewrites NOTHING — no row's `xmin`
 *      changes, and the table-wide `n_tup_upd` delta is reported (best-effort;
 *      see the caveat below).
 *   2. A turn whose text actually changed still updates (`xmin` changes) AND
 *      still nulls its embedding (mt#3883's invariant, unweakened by this fix).
 *   3. A turn whose `assistant_text` is NULL in both the stored row and the
 *      incoming value is NOT rewritten — the case a naive `<>` predicate gets
 *      wrong (`NULL <> NULL` is NULL, not TRUE), proving the guard uses `IS
 *      DISTINCT FROM`.
 *   4. COUNTER-CASE: a turn whose ONLY difference is `is_spawn_boundary` still
 *      updates, even though its text is byte-identical — proving the predicate
 *      compares every SET column, not just the text pair the embedding CASE
 *      reads.
 *
 * **Measurement caveat.** `pg_stat_user_tables` counters are table-wide and
 * cumulative since the last stats reset — on a table also receiving live
 * capture-path traffic, a concurrent write elsewhere in the table can inflate
 * the observed `n_tup_upd` delta during this script's brief window. The
 * per-row `xmin` checks are the PASS/FAIL signal (immune to that noise, since
 * they only ever look at this script's own scratch rows); the
 * `pg_stat_user_tables` deltas are reported as the measured-effect evidence
 * the spec asks for, not as a second pass/fail gate.
 *
 * Usage:
 *   bun scripts/verify-turn-write-skip-if-unchanged.ts
 *
 * Exits 0 on pass, 1 on failure, and 0 with a SKIP notice when no Postgres
 * connection is configured (safe in an environment without DB creds).
 *
 * **Blast radius.** Writes ONE scratch `agent_transcripts` row plus its turn
 * rows, under a fixed, obviously-synthetic conversation id, and deletes them in
 * a `finally`. It never touches a real conversation. A leftover from an
 * interrupted run is cleaned up by the next run before it starts.
 *
 * @see packages/domain/src/transcripts/turn-writer.ts — the `setWhere` guard
 * @see scripts/verify-turn-embedding-invalidation.ts — the sibling this follows
 * @see mt#4345
 */

import "reflect-metadata";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";

import type { RawTurnLine } from "@minsky/domain/transcripts/transcript-source";

/**
 * What `getDatabaseConnection()` ACTUALLY returns at runtime (a `drizzle()`
 * result, which carries `$client`), narrower than what
 * `SqlCapablePersistenceProvider.getDatabaseConnection()` is TYPED to return
 * (plain `PostgresJsDatabase`, per `packages/domain/src/persistence/types.ts`
 * — the public interface's return type doesn't encode this because most
 * callers never need the raw client). An additive intersection, not a
 * replacement, so casting `db as PostgresJsDatabaseWithClient` is a single
 * `as`, never `as unknown as`.
 */
type PostgresJsDatabaseWithClient = PostgresJsDatabase & {
  $client: { end(options?: { timeout?: number }): Promise<void> };
};

/**
 * Fixed, obviously-synthetic subject. The `4345` group makes its origin
 * greppable if a run is ever interrupted before cleanup.
 */
const SCRATCH_SESSION = "00000000-4345-4000-8000-000000000001";

/** Matches `agent_transcript_turns.embedding`'s declared dimensions. */
const EMBEDDING_DIMENSIONS = 1536;

/**
 * Attaches a fake but well-formed vector to one scratch turn row, the way the
 * embedding backfill would. `fillValue` differentiates AT2's and AT4's
 * attach calls only so a stray leftover from one is visibly distinguishable
 * from the other if a run is ever interrupted mid-way; the tests below never
 * inspect the vector's actual values, only whether the column is NULL.
 */
async function attachFakeEmbedding(
  db: PostgresJsDatabase,
  turnIndex: number,
  fillValue: string
): Promise<void> {
  await db.execute(
    sql`UPDATE agent_transcript_turns
        SET embedding = (
          SELECT ('[' || string_agg(${fillValue}, ',') || ']')::vector
          FROM generate_series(1, ${EMBEDDING_DIMENSIONS})
        )
        WHERE agent_session_id = ${SCRATCH_SESSION} AND turn_index = ${turnIndex}`
  );
}

/** `turn_index:xmin` map for every row belonging to the scratch session. */
async function readXmins(db: PostgresJsDatabase): Promise<Map<number, string>> {
  const rows = (await db.execute(
    sql`SELECT turn_index, xmin::text AS xmin
        FROM agent_transcript_turns
        WHERE agent_session_id = ${SCRATCH_SESSION}
        ORDER BY turn_index`
  )) as Array<Record<string, unknown>>;
  return new Map(rows.map((r) => [Number(r["turn_index"]), String(r["xmin"])]));
}

async function readEmbeddingIsNull(db: PostgresJsDatabase, turnIndex: number): Promise<boolean> {
  const rows = (await db.execute(
    sql`SELECT embedding IS NULL AS is_null
        FROM agent_transcript_turns
        WHERE agent_session_id = ${SCRATCH_SESSION} AND turn_index = ${turnIndex}`
  )) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) throw new Error(`scratch turn row ${turnIndex} not found — the write did not land`);
  return row["is_null"] === true;
}

async function readIsSpawnBoundary(db: PostgresJsDatabase, turnIndex: number): Promise<boolean> {
  const rows = (await db.execute(
    sql`SELECT is_spawn_boundary
        FROM agent_transcript_turns
        WHERE agent_session_id = ${SCRATCH_SESSION} AND turn_index = ${turnIndex}`
  )) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) throw new Error(`scratch turn row ${turnIndex} not found — the write did not land`);
  return row["is_spawn_boundary"] === true;
}

interface TurnTableStats {
  nTupUpd: number;
  nDeadTup: number;
  nTupHotUpd: number;
}

/**
 * Reads `pg_stat_user_tables` for `agent_transcript_turns` — but ALWAYS after
 * `pg_stat_clear_snapshot()`, not a bare read. Postgres's default
 * `stats_fetch_consistency = cache` gives each backend/transaction ONE
 * statistics snapshot, cached until something clears it — so a bare
 * back-to-back read from the SAME session can return a snapshot taken
 * BEFORE a write this same script just made, under-reporting it as `+0`
 * even though the write genuinely happened (observed while developing this
 * script: a real single-row UPDATE, confirmed via `xmin`, read `n_tup_upd
 * +0` on the very next stats query). `pg_stat_clear_snapshot()` forces the
 * NEXT read in this session to re-fetch current values rather than serving
 * the cached one.
 *
 * This addresses SNAPSHOT STALENESS, not CONCURRENT-WRITER noise — a
 * DIFFERENT backend genuinely writing to this table between two reads still
 * shows up in the delta and cannot be distinguished from this script's own
 * write by a table-wide counter. See the caller's reporting for how that
 * residual noise is bounded rather than asserted away.
 */
async function readTableStats(db: PostgresJsDatabase): Promise<TurnTableStats> {
  await db.execute(sql`SELECT pg_stat_clear_snapshot()`);
  const rows = (await db.execute(
    sql`SELECT n_tup_upd, n_dead_tup, n_tup_hot_upd
        FROM pg_stat_user_tables
        WHERE relname = 'agent_transcript_turns'`
  )) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) throw new Error("pg_stat_user_tables has no row for agent_transcript_turns");
  return {
    nTupUpd: Number(row["n_tup_upd"]),
    nDeadTup: Number(row["n_dead_tup"]),
    nTupHotUpd: Number(row["n_tup_hot_upd"]),
  };
}

function statsDeltaLine(before: TurnTableStats, after: TurnTableStats): string {
  return (
    `n_tup_upd +${after.nTupUpd - before.nTupUpd}, ` +
    `n_dead_tup +${after.nDeadTup - before.nDeadTup}, ` +
    `n_tup_hot_upd +${after.nTupHotUpd - before.nTupHotUpd}`
  );
}

/**
 * Turn 0: a normal (user, assistant) pair with text on both sides.
 * Turn 1: a TRAILING user-only line — extractTurns emits this as a partial
 * turn with `assistantText: null` (turn-extractor.ts: "a trailing user line
 * with no following assistant line is emitted as a partial turn"). Re-sending
 * the identical transcript keeps turn 1's `assistant_text` NULL on both sides
 * — the AT3 NULL-handling case.
 */
function baseTranscript(turn0AssistantText = "original reply"): RawTurnLine[] {
  return [
    {
      type: "user",
      timestamp: "2026-01-01T10:00:00.000Z",
      message: { role: "user", content: "turn zero prompt" },
    },
    {
      type: "assistant",
      timestamp: "2026-01-01T10:00:01.000Z",
      message: {
        role: "assistant",
        id: "msg_scratch_0",
        content: [{ type: "text", text: turn0AssistantText }],
      },
    },
    {
      type: "user",
      timestamp: "2026-01-01T10:00:02.000Z",
      message: { role: "user", content: "trailing prompt, no reply yet" },
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

    // ── Setup: first write materializes both turns ────────────────────────
    const first = await writeTurnsForTranscript(db, SCRATCH_SESSION, baseTranscript());
    if (first.written !== 2) {
      console.error(`FAIL: expected 2 turns written on setup, got ${first.written}`);
      return 1;
    }

    // Give turn 0 a vector, the way the embedding backfill would, so AT2 can
    // observe it getting nulled.
    await attachFakeEmbedding(db, 0, "0.001");
    if (await readEmbeddingIsNull(db, 0)) {
      console.error("FAIL: setup did not attach an embedding — the rest proves nothing.");
      return 1;
    }

    // ── AT1: re-ingesting an IDENTICAL transcript rewrites nothing ────────
    const xminsBefore = await readXmins(db);
    const statsBefore = await readTableStats(db);

    const second = await writeTurnsForTranscript(db, SCRATCH_SESSION, baseTranscript());
    if (second.written !== 2) {
      console.error(`FAIL: expected 2 turns reported written on re-ingest, got ${second.written}`);
      return 1;
    }

    const xminsAfter = await readXmins(db);
    const statsAfter = await readTableStats(db);

    for (const turnIndex of [0, 1]) {
      if (xminsBefore.get(turnIndex) !== xminsAfter.get(turnIndex)) {
        console.error(
          `FAIL (AT1): turn ${turnIndex}'s xmin changed on an identical re-ingest ` +
            `(${xminsBefore.get(turnIndex)} -> ${xminsAfter.get(turnIndex)}) — the row was ` +
            `rewritten even though nothing changed.`
        );
        return 1;
      }
    }
    console.log(
      `PASS (AT1): identical re-ingest rewrote neither row (xmin unchanged — the PASS/FAIL ` +
        `signal above, immune to concurrent-writer noise since it only inspects this script's own ` +
        `rows). Table-wide stats delta (informational only, not gating; ` +
        `see the HOT-update measurement below for why): ${statsDeltaLine(statsBefore, statsAfter)}.`
    );

    // Turn 1's assistant_text was NULL before and is NULL again (trailing
    // user-only line, both passes) — its xmin-unchanged check above already
    // proves AT3 (the NULL <> NULL trap), but assert the NULL shape explicitly
    // so a future fixture change can't silently stop exercising it.
    const turn1Rows = (await db.execute(
      sql`SELECT assistant_text FROM agent_transcript_turns
          WHERE agent_session_id = ${SCRATCH_SESSION} AND turn_index = 1`
    )) as Array<Record<string, unknown>>;
    if (turn1Rows[0]?.["assistant_text"] !== null) {
      console.error("FAIL (AT3 setup): turn 1's assistant_text is not NULL — fixture is wrong.");
      return 1;
    }
    console.log("PASS (AT3): NULL assistant_text on both sides did not force a rewrite.");

    // ── AT2: a genuinely changed turn still updates AND nulls its embedding ─
    const xminBeforeChange = (await readXmins(db)).get(0);
    const statsBeforeChange = await readTableStats(db);
    await writeTurnsForTranscript(
      db,
      SCRATCH_SESSION,
      baseTranscript("a genuinely different reply")
    );
    const xminAfterChange = (await readXmins(db)).get(0);
    const statsAfterChange = await readTableStats(db);

    if (xminBeforeChange === xminAfterChange) {
      console.error(
        "FAIL (AT2): turn 0's text changed but its xmin did not — the row was not updated."
      );
      return 1;
    }
    if (!(await readEmbeddingIsNull(db, 0))) {
      console.error(
        "FAIL (AT2): turn 0's text changed but its embedding survived — mt#3883's invalidation " +
          "invariant is broken by the new setWhere guard."
      );
      return 1;
    }
    console.log(
      "PASS (AT2): changed text updated the row and nulled its embedding (mt#3883 intact)."
    );

    // Spec's "expected mechanism, NOT measured" claim: a real UPDATE here
    // cannot take the HOT path because the indexed `embedding` column sits in
    // the SET list. This script issues exactly ONE real UPDATE (turn_index=0
    // only) here, so IF the table-wide n_tup_upd delta reads exactly +1 —
    // i.e. attributable to this script alone, not muddied by a concurrent
    // writer — n_tup_hot_upd should read +0 if the spec's claim holds.
    //
    // `pg_stat_user_tables` is table-wide and cumulative (flagged on PR #3176
    // review round 1): capture-path traffic elsewhere on this table during
    // this brief window
    // can move these counters too, and a table-wide delta cannot distinguish
    // that from this script's own write. So the verdict below is bounded to
    // the case where the delta is EXACTLY attributable to this one write
    // (updDelta === 1); any other reading is reported as inconclusive rather
    // than asserted as a positive or negative result.
    const updDelta = statsAfterChange.nTupUpd - statsBeforeChange.nTupUpd;
    const hotDelta = statsAfterChange.nTupHotUpd - statsBeforeChange.nTupHotUpd;
    const hotUpdateVerdict =
      updDelta === 1
        ? hotDelta === 0
          ? "CONFIRMED: this UPDATE was NOT a HOT update (n_tup_hot_upd did not advance), as the spec expected."
          : "NOT CONFIRMED: this UPDATE WAS a HOT update (n_tup_hot_upd advanced alongside n_tup_upd) — the spec's expected mechanism does not hold here."
        : `INCONCLUSIVE: n_tup_upd advanced by ${updDelta}, not the expected +1 for this script's ` +
          "single write — table-wide counters can be moved by concurrent capture-path traffic on " +
          "this table during the measurement window, so this delta is not read as evidence either way.";
    console.log(
      `MEASURED (spec's HOT-update claim): one real UPDATE issued by this script (turn_index=0); ` +
        `table-wide delta: ${statsDeltaLine(statsBeforeChange, statsAfterChange)}. ${hotUpdateVerdict}`
    );

    // ── AT4 (counter-case): is_spawn_boundary-only divergence still updates ─
    // Directly flip the STORED row's is_spawn_boundary to simulate a value
    // that diverges from what a fresh extraction computes, with text held
    // identical — the shape that a text-only predicate would silently miss.
    await db.execute(
      sql`UPDATE agent_transcript_turns SET is_spawn_boundary = true
          WHERE agent_session_id = ${SCRATCH_SESSION} AND turn_index = 0`
    );
    // Re-attach an embedding: the AT2 write above nulled it, and this check
    // wants to confirm embedding PRESERVATION on a write that IS real but
    // text-unchanged — a different case from AT2's text-changed null.
    await attachFakeEmbedding(db, 0, "0.002");
    const xminBeforeFlip = (await readXmins(db)).get(0);

    // Re-ingest the SAME text used to set up AT2 ("a genuinely different
    // reply") — extractTurns computes is_spawn_boundary = false for it (no
    // Agent tool call), which now DIFFERS from the stored `true` above while
    // every text column matches exactly.
    await writeTurnsForTranscript(
      db,
      SCRATCH_SESSION,
      baseTranscript("a genuinely different reply")
    );
    const xminAfterFlip = (await readXmins(db)).get(0);

    if (xminBeforeFlip === xminAfterFlip) {
      console.error(
        "FAIL (AT4 counter-case): is_spawn_boundary diverged from incoming with identical text, " +
          "but the row's xmin did not change — a real change was silently dropped by the guard."
      );
      return 1;
    }
    if (await readIsSpawnBoundary(db, 0)) {
      console.error("FAIL (AT4): row updated but is_spawn_boundary still reads true post-write.");
      return 1;
    }
    if (await readEmbeddingIsNull(db, 0)) {
      console.error(
        "FAIL (AT4): the is_spawn_boundary-only update nulled the embedding — text was unchanged, " +
          "so mt#3883's CASE expression should have preserved it."
      );
      return 1;
    }
    console.log(
      "PASS (AT4 counter-case): an is_spawn_boundary-only divergence still updated the row " +
        "(xmin changed) and correctly preserved the embedding (text was unchanged)."
    );

    console.log("\nverify-turn-write-skip-if-unchanged: PASS (4/4)");
    return 0;
  } finally {
    await removeScratchRows(db);
    // Close the connection pool this run opened (PR #3176 R1: the DI
    // container's `getDatabaseConnection()` opens a real postgres-js pool
    // with no built-in teardown call — leaving it open relies on
    // `process.exit()` to tear it down forcibly, which can race in-flight
    // cleanup work rather than let it finish). `$client` is postgres-js's
    // own handle on the underlying connection — present at runtime on every
    // `PostgresJsDatabase` `drizzle()` actually constructs, but only typed
    // on `drizzle()`'s own return type, not on the plain `PostgresJsDatabase`
    // interface `SqlCapablePersistenceProvider.getDatabaseConnection()` is
    // declared to return. `PostgresJsDatabaseWithClient` names that gap as an
    // ADDITIVE intersection — same base type, one extra known-present field —
    // so this narrows via a single `as`, not the double `as unknown as` an
    // outright type SWAP would need. A short timeout bounds how long this
    // waits for in-flight queries to drain before closing anyway.
    const { $client } = db as PostgresJsDatabaseWithClient;
    await $client.end({ timeout: 5 });
  }
}

main()
  .then((code) => {
    // No explicit process.exit(): now that the DB pool above is closed in
    // `finally`, nothing keeps the event loop alive, so the process exits
    // naturally with this code once main() has fully settled — rather than
    // forcing termination and risking a race with unflushed cleanup.
    process.exitCode = code;
  })
  .catch((err) => {
    console.error("verify-turn-write-skip-if-unchanged: ERROR", err);
    process.exitCode = 1;
  });

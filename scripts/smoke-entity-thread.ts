#!/usr/bin/env bun
/**
 * Live smoke for the entity discussion thread store (mt#3364).
 *
 * Exercises the REAL persistence path against a live database — the seam-injected
 * unit tests in packages/domain/src/transcripts/entity-thread-store.test.ts prove
 * the mapping and projection logic, but not that the SQL actually runs, that the
 * atomic seq allocation actually allocates, or that the migration's tables exist
 * with the columns the code expects.
 *
 * Covers mt#3364's acceptance tests AT1 (round-trip survives a fresh read),
 * AT2 (projection to render blocks), and AT4 (nothing lands in agent_transcripts).
 * AT3 (seeded spawn of the genuine `claude` binary) is deliberately NOT here —
 * spawning it spends real credit, and driving it is the operator's call.
 *
 * Skips gracefully (exit 0) when no database is configured or when the mt#3364
 * migration has not been applied, so it is safe to run anywhere.
 *
 * Usage:
 *   bun scripts/smoke-entity-thread.ts            # read/write a scratch thread, then clean up
 *   bun scripts/smoke-entity-thread.ts --keep     # leave the scratch rows for inspection
 */

import "reflect-metadata";
import { sql } from "drizzle-orm";
import { setupConfiguration } from "../packages/domain/src/config-setup";

import {
  appendEntityThreadTurn,
  entityThreadLocalId,
  getOrCreateEntityThread,
  listEntityThreadBlocks,
  listEntityThreadTurns,
} from "../packages/domain/src/transcripts/entity-thread-store";

const KEEP = process.argv.includes("--keep");

/** A scratch entity id, namespaced so it can never collide with a real ask. */
const SCRATCH_ENTITY_ID = `smoke-${process.pid}-${process.hrtime.bigint()}`;

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function check(condition: boolean, message: string): void {
  if (!condition) fail(message);
  console.log(`  ok: ${message}`);
}

async function main(): Promise<void> {
  // Configuration MUST be initialized before persistence resolves, or the
  // provider throws and this script reports a SKIP that looks like "no
  // database configured" while actually hiding a bootstrap failure — a probe
  // that cannot fail carries no information.
  await setupConfiguration();

  // The same resolution path the cockpit route uses — returns the drizzle
  // handle the store takes, rather than a raw connection needing a wrapper.
  const { createCachedSqlDbGetter } = await import("../src/cockpit/db-providers");
  const db = await createCachedSqlDbGetter({ cacheNegative: false })();
  if (!db) {
    console.log("SKIP: no SQL database connection available");
    process.exit(0);
  }

  // Gate on the migration having been applied — running against a database
  // without these tables is a legitimate skip, not a failure.
  const tables = await db.execute(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('entity_threads', 'entity_thread_turns')
  `);
  if (Array.from(tables as Iterable<unknown>).length < 2) {
    console.log("SKIP: mt#3364 migration (0079) not applied to this database");
    process.exit(0);
  }

  const before = Array.from(
    (await db.execute(sql`SELECT count(*)::int AS n FROM agent_transcripts`)) as Iterable<{
      n: number;
    }>
  )[0]?.n;

  console.log(`entity-thread smoke — scratch entity ${SCRATCH_ENTITY_ID}`);

  // --- AT1: create, append, read back ---
  const thread = await getOrCreateEntityThread(db, {
    entityType: "ask",
    entityId: SCRATCH_ENTITY_ID,
  });
  check(
    thread.localId === entityThreadLocalId("ask", SCRATCH_ENTITY_ID),
    "thread localId matches the deterministic derivation"
  );

  // Idempotence: a second open must not mint a second thread.
  const again = await getOrCreateEntityThread(db, {
    entityType: "ask",
    entityId: SCRATCH_ENTITY_ID,
  });
  check(again.localId === thread.localId, "re-opening the same entity returns the same thread");

  const first = await appendEntityThreadTurn(db, {
    localId: thread.localId,
    role: "operator",
    content: "what is this ask actually asking me?",
  });
  const second = await appendEntityThreadTurn(db, {
    localId: thread.localId,
    role: "agent",
    content: "it is an authorization request from a session on mt#3360",
  });
  check(first.seq === 1 && second.seq === 2, "seq allocated monotonically by the database");
  check(first.id !== second.id, "turn ids are distinct");

  const turns = await listEntityThreadTurns(db, thread.localId);
  check(turns.length === 2, "both turns read back");
  check(
    turns[0]?.role === "operator" && turns[1]?.role === "agent",
    "turns come back in seq order with roles intact"
  );

  // --- AT2: projection to render blocks ---
  const blocks = await listEntityThreadBlocks(db, thread.localId);
  check(blocks.length === 2, "both turns project to blocks");
  check(
    blocks[0]?.type === "user-prompt" && blocks[1]?.type === "assistant-text",
    "roles project to the existing block taxonomy"
  );
  check(
    blocks.every((b) => b.source === "observed" && !!b.timestamp && !!b.rawJsonlType),
    "every block carries the fields SessionContextSnapshotBlock requires"
  );
  check(
    blocks.every((b) => b.id.startsWith("entity-thread:")),
    "block ids are namespaced away from snapshot block ids"
  );

  // --- AT4: nothing landed in agent_transcripts ---
  const after = Array.from(
    (await db.execute(sql`SELECT count(*)::int AS n FROM agent_transcripts`)) as Iterable<{
      n: number;
    }>
  )[0]?.n;
  check(before === after, `agent_transcripts row count unchanged (${before} -> ${after})`);

  if (!KEEP) {
    await db.execute(sql`DELETE FROM entity_thread_turns WHERE local_id = ${thread.localId}`);
    await db.execute(sql`DELETE FROM entity_threads WHERE local_id = ${thread.localId}`);
    console.log("  cleaned up scratch rows");
  } else {
    console.log(`  --keep: left scratch thread ${thread.localId} in place`);
  }

  console.log("PASS: entity-thread smoke");
}

main().catch((err) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});

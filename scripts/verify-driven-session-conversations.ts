#!/usr/bin/env bun
/**
 * Live verification of the conversation-adoption series (mt#4323, ADR-044).
 *
 * Why the unit tests are not enough. They inject a fake DB, so they prove the
 * TypeScript is right — append-only intent, the never-throw contract, the
 * discriminated read result, the projection's scan. Three things they
 * structurally cannot reach, and all three are where this change can silently
 * fail:
 *
 *   1. **The DDL.** Migration 0103 either created `driven_session_conversations`
 *      with these columns or it did not. A fake answers the same either way.
 *   2. **`ORDER BY adopted_at ASC, seq ASC`.** The span's ordering lives in SQL.
 *      The fake SORTS FOR the code rather than observing it sort, so a wrong
 *      or missing ORDER BY is invisible to every test in the suite.
 *   3. **That the insert reaches a real table at all.** mt#3254's lesson: a
 *      seam-tested binding rendered healthy zeros for five weeks. A write that
 *      never lands looks exactly like the empty table it was meant to fill.
 *
 * What it does, all against the real configured database:
 *   1. Asserts the table exists and carries the six expected columns.
 *   2. Appends three adoptions for a throwaway localId — initial, then two
 *      swaps — with adopted_at values deliberately written OUT of insertion
 *      order, so a missing ORDER BY produces a different answer than a
 *      present one.
 *   3. Asserts resolveConversationIds returns all three, oldest first.
 *   4. Asserts the first row is byte-identical afterwards (append-only, not
 *      an upsert) — AT1 against a real unique/PK constraint rather than a fake.
 *   5. Asserts resolveReplacedConversationId projects the newest swap's
 *      predecessor.
 *   6. Removes every row it wrote.
 *
 * Usage (from the repo root):
 *
 *   # against a scratch local database — the recommended way to run it
 *   MINSKY_VERIFY_DATABASE_URL=postgres://localhost:5432/minsky_verify \
 *     bun scripts/verify-driven-session-conversations.ts --i-understand-this-writes
 *
 *   # against whatever the environment resolves (production, in this repo)
 *   bun scripts/verify-driven-session-conversations.ts --i-understand-this-writes
 *
 * The flag is required because this probe WRITES. Unlike its sibling
 * verify-boot-verdict-persist.ts it touches ONLY rows carrying its own
 * generated probe id, and removes them in a `finally` so a mid-probe failure
 * still cleans up.
 *
 * `MINSKY_VERIFY_DATABASE_URL` exists so the probe can be run pre-merge
 * WITHOUT applying this task's migration to production first: point it at a
 * scratch database, apply the migration there, and every property under test
 * (the DDL, the `ORDER BY`, the append-only constraint) is exercised against a
 * real Postgres. It is read from the ENVIRONMENT rather than taken as a flag
 * on purpose — argv is world-readable through `ps`, and a connection string is
 * exactly the kind of value that must not land there.
 *
 * Exit codes: 0 = pass, 1 = failure (reason printed).
 */

// Must come first: the config bootstrap below pulls in tsyringe.
import "reflect-metadata";

const OVERRIDE_URL = process.env.MINSKY_VERIFY_DATABASE_URL;

// The daemon initializes configuration at boot; a standalone script must do it
// explicitly, or the database resolves null and the write silently no-ops —
// which would make this probe report a pass it did not earn. Skipped entirely
// when an override URL is supplied: nothing then reads the configured
// provider, so bootstrapping it would only risk resolving production.
if (!OVERRIDE_URL) {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });
}

const { sql } = await import("drizzle-orm");
const store = await import("@minsky/domain/transcripts/driven-session-registry-store");

/** The configured provider, or a direct connection to the override URL. */
async function resolveDb(): Promise<import("drizzle-orm/postgres-js").PostgresJsDatabase | null> {
  if (OVERRIDE_URL) {
    const postgres = (await import("postgres")).default;
    const { drizzle } = await import("drizzle-orm/postgres-js");
    return drizzle(postgres(OVERRIDE_URL, { max: 1 }));
  }
  const { getContextInspectorDb } = await import("../src/cockpit/db-providers");
  return getContextInspectorDb();
}

const PROBE_ID = `mt4323-adoption-probe-${Date.now()}`;
const HARNESS = "claude_code";

const EXPECTED_COLUMNS = [
  "driver_generation",
  "adopted_at",
  "adoption_reason",
  "harness",
  "harness_session_id",
  "id",
  "local_id",
  "seq",
];

function fail(reason: string): never {
  console.error(`FAIL: ${reason}`);
  process.exit(1);
}

if (!process.argv.includes("--i-understand-this-writes")) {
  console.error(
    "REFUSED: this probe writes to the configured database (production, in this repo).\n" +
      `It writes only rows keyed to its own generated probe id and removes them\n` +
      "afterwards, but that is still a real state change.\n" +
      "Re-run with --i-understand-this-writes if that is what you intend."
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const db = await resolveDb();
  if (!db) fail("no SQL persistence available — cannot verify the real binding");
  console.log(
    `      target: ${OVERRIDE_URL ? "MINSKY_VERIFY_DATABASE_URL override" : "the configured provider"}`
  );

  try {
    console.log("[1/6] asserting the table and its columns exist");
    const cols = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'driven_session_conversations'
    `);
    const found = Array.from(cols as Iterable<{ column_name: string }>)
      .map((r) => r.column_name)
      .sort();
    if (found.length === 0) {
      fail("driven_session_conversations does not exist — migration 0103 has not been applied");
    }
    for (const col of EXPECTED_COLUMNS) {
      if (!found.includes(col)) fail(`column "${col}" is missing (found: ${found.join(", ")})`);
    }
    console.log(`      ok — ${found.length} columns: ${found.join(", ")}`);

    console.log("[2/6] appending three adoptions, timestamps written OUT of insertion order");
    // conv-b is inserted SECOND but stamped LAST. If the span query has no
    // ORDER BY (or orders by insertion), it returns a-b-c and this probe still
    // passes step 3 by accident — so the expected order below is a-c-b, which
    // ONLY an adopted_at sort produces.
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const t1 = new Date("2026-01-01T00:00:01.000Z");
    const t2 = new Date("2026-01-01T00:00:02.000Z");

    // `.toISOString()`, not the Date itself: this is the RAW-SQL path, where
    // the Postgres driver binds parameters with no column type to consult and rejects a
    // Date outright. The production writer does not have this problem — it
    // goes through drizzle's typed insert builder, which knows the column is
    // `timestamptz` and serializes for it. Seeding by hand here is what makes
    // step 3's out-of-order timestamps possible at all.
    const append = async (convId: string, reason: string, at: Date): Promise<void> => {
      await db.execute(sql`
        INSERT INTO driven_session_conversations
          (local_id, harness_session_id, harness, driver_generation, adoption_reason, adopted_at)
        VALUES (${PROBE_ID}, ${convId}, ${HARNESS}, 0, ${reason}, ${at.toISOString()})
      `);
    };
    await append(`${PROBE_ID}-a`, "initial", t0);
    await append(`${PROBE_ID}-b`, "prior-conversation-unrecoverable", t2);
    await append(`${PROBE_ID}-c`, "prior-conversation-unrecoverable", t1);
    console.log("      wrote 3 rows (a@t0, b@t2, c@t1)");

    console.log("[3/6] resolving the span through the real function");
    const span = await store.resolveConversationIds(db, PROBE_ID);
    if (!span.ok) fail(`the span read failed: ${span.error}`);
    const expected = [`${PROBE_ID}-a`, `${PROBE_ID}-c`, `${PROBE_ID}-b`];
    console.log(`      got: ${span.conversationIds.join(", ")}`);
    if (span.conversationIds.length !== 3) {
      fail(`expected 3 conversation ids, got ${span.conversationIds.length}`);
    }
    if (span.conversationIds.join(",") !== expected.join(",")) {
      fail(
        `span is not ordered by adopted_at — expected ${expected.join(", ")}, ` +
          `got ${span.conversationIds.join(", ")}`
      );
    }
    console.log("      ok — three ids, ordered by adopted_at (not by insertion)");

    console.log("[4/6] asserting the series is append-only, not an upsert");
    const rowsBefore = await db.execute(sql`
      SELECT id, seq, harness_session_id, adoption_reason, adopted_at
      FROM driven_session_conversations WHERE local_id = ${PROBE_ID}
        AND harness_session_id = ${`${PROBE_ID}-a`}
    `);
    const first = Array.from(rowsBefore as Iterable<Record<string, unknown>>)[0];
    if (!first) fail("the initial row vanished");

    // Re-adopt the SAME conversation id through the real writer. An upsert
    // would mutate the existing row; the contract is a second row.
    const outcome = await store.recordConversationAdoption(db, {
      localId: PROBE_ID,
      harnessSessionId: `${PROBE_ID}-a`,
      harness: HARNESS,
      adoptionReason: "resumed",
    });
    if (outcome !== "written") fail(`recordConversationAdoption returned "${outcome}"`);

    const rowsAfter = await db.execute(sql`
      SELECT id, seq, harness_session_id, adoption_reason, adopted_at
      FROM driven_session_conversations WHERE local_id = ${PROBE_ID}
        AND harness_session_id = ${`${PROBE_ID}-a`}
      ORDER BY adopted_at ASC, seq ASC
    `);
    const after = Array.from(rowsAfter as Iterable<Record<string, unknown>>);
    if (after.length !== 2) fail(`expected 2 rows for the re-adopted id, got ${after.length}`);
    if (JSON.stringify(after[0]) !== JSON.stringify(first)) {
      fail(
        `the original row CHANGED — append-only violated.\n` +
          `  before: ${JSON.stringify(first)}\n  after:  ${JSON.stringify(after[0])}`
      );
    }
    console.log("      ok — two rows for the re-adopted id, the first byte-identical");

    console.log("[5/6] two adoptions sharing one timestamp resolve in INSERTION order");
    // The regression probe for PR #3218 R1. `adopted_at` is a JS Date with
    // millisecond resolution, so two adoptions on one session really can tie —
    // and until this round the tiebreak was `id`, a random uuid, which decides
    // a tie at random while reading like a tiebreak. Two rows at the SAME
    // instant is the only shape that can tell `seq` from `id`: with distinct
    // timestamps both orderings agree, which is why steps 2-3 could not catch
    // this.
    const TIE = new Date("2026-01-01T00:00:05.000Z");
    const tieId = `${PROBE_ID}-tie`;
    await db.execute(sql`
      INSERT INTO driven_session_conversations
        (local_id, harness_session_id, harness, driver_generation, adoption_reason, adopted_at)
      VALUES (${tieId}, ${"tie-first"}, ${HARNESS}, 0, ${"initial"}, ${TIE.toISOString()})
    `);
    await db.execute(sql`
      INSERT INTO driven_session_conversations
        (local_id, harness_session_id, harness, driver_generation, adoption_reason, adopted_at)
      VALUES (${tieId}, ${"tie-second"}, ${HARNESS}, 0, ${"resumed"}, ${TIE.toISOString()})
    `);
    const tieSpan = await store.resolveConversationIds(db, tieId);
    if (!tieSpan.ok) fail(`the tie-span read failed: ${tieSpan.error}`);
    console.log(`      got: ${tieSpan.conversationIds.join(", ")}`);
    if (tieSpan.conversationIds.join(",") !== "tie-first,tie-second") {
      fail(
        `equal-timestamp adoptions are not in insertion order — got ` +
          `${tieSpan.conversationIds.join(", ")}. The ORDER BY tiebreak is not monotonic.`
      );
    }
    await db.execute(sql`DELETE FROM driven_session_conversations WHERE local_id = ${tieId}`);
    console.log("      ok — the tiebreak is monotonic, not random");

    console.log("[6/6] projecting replaced_conversation_id from the series");
    const replaced = await store.resolveReplacedConversationId(db, PROBE_ID);
    // The newest SWAP is b@t2; the adoption immediately before it is c@t1.
    const expectedReplaced = `${PROBE_ID}-c`;
    console.log(`      got: ${replaced ?? "(undefined)"}`);
    if (replaced !== expectedReplaced) {
      fail(`expected the projection to return ${expectedReplaced}, got ${replaced ?? "undefined"}`);
    }
    console.log("      ok — the projection names the conversation the newest swap replaced");
  } finally {
    const removed = await db.execute(sql`
      DELETE FROM driven_session_conversations WHERE local_id = ${PROBE_ID}
    `);
    console.log(`      cleanup: removed probe rows for ${PROBE_ID} (${String(removed ?? "")})`);
  }

  console.log(
    "PASS: the table exists, the span is ordered by adopted_at, the series is append-only, " +
      "and the replaced-id projection resolves"
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});

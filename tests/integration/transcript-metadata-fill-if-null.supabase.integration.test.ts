/**
 * mt#3342 AT1/AT2 — the ingest upsert's fill-if-null metadata semantics,
 * exercised against a REAL Postgres.
 *
 * ## Why this is an integration test rather than a unit test
 *
 * The fix IS raw SQL: `COALESCE(NULLIF(harness, 'unknown'), EXCLUDED.harness)`
 * inside an `onConflictDoUpdate` SET clause. The ingest-service unit suite runs
 * against a hand-rolled fake DB that RECORDS the statement without evaluating
 * it, so a unit test asserting these semantics would pass no matter what the SQL
 * said — the "check whose passing output is silence" shape. `NULLIF` and
 * `EXCLUDED` only mean anything to a real Postgres.
 *
 * ## Why it imports the production fragment
 *
 * It builds its upsert from {@link fillIfNullMetadataSet} — the SAME exported
 * value `ingestSession` spreads into its SET clause — rather than re-typing the
 * SQL. A test carrying its own copy would assert that the copy works and stay
 * green while the production statement regressed, which is precisely the gap
 * `minsky-reviewer[bot]` flagged as BLOCKING on PR #2412 ("CI cannot catch
 * regressions in the raw SQL change").
 *
 * Skips (does not fail) without a database, matching
 * `postgres-pool-saturation.supabase.integration.test.ts`'s convention:
 *
 *   RUN_INTEGRATION_TESTS=1
 *   SUPABASE_INTEGRATION_BRANCH_URL=<postgres connection string>
 *
 * @see mt#3342 — this task
 * @see packages/domain/src/transcripts/agent-transcript-ingest-service.ts — fillIfNullMetadataSet
 */
import { describe, test, expect, afterAll } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { agentTranscriptsTable } from "@minsky/domain/storage/schemas/agent-transcripts-schema";
import { fillIfNullMetadataSet } from "@minsky/domain/transcripts/agent-transcript-ingest-service";
import type { ConversationId } from "@minsky/domain/ids";

const BRANCH_URL = process.env.SUPABASE_INTEGRATION_BRANCH_URL;

/** Matches `recordIngestFailure`'s placeholder — the value the bug wrote. */
const UNKNOWN_HARNESS = "unknown";
const REAL_HARNESS = "claude_code";

const TRUE_START = new Date("2020-01-02T03:04:05.000Z");
/** Deliberately LATER than TRUE_START — the negative control's whole point. */
const LATER_START = new Date("2021-06-07T08:09:10.000Z");

if (process.env.RUN_INTEGRATION_TESTS && BRANCH_URL) {
  const client = postgres(BRANCH_URL, { max: 2 });
  const db = drizzle(client);
  const scratchIds: ConversationId[] = [];

  /**
   * Mint at the boundary: `agent_transcripts.agent_session_id` is a BRANDED
   * `ConversationId` column, so a plain string is rejected by the query
   * builder's overloads (TS2769). Minting here keeps the cast in one place.
   */
  function scratchId(suffix: string): ConversationId {
    const id = `mt3342-it-${suffix}-${process.pid}-${scratchIds.length}` as ConversationId;
    scratchIds.push(id);
    return id;
  }

  /** The production upsert shape, narrowed to the columns under test. */
  async function upsert(
    agentSessionId: ConversationId,
    values: { harness: string; startedAt?: Date; cwd?: string }
  ): Promise<void> {
    await db
      .insert(agentTranscriptsTable)
      .values({ agentSessionId, ...values })
      .onConflictDoUpdate({
        target: agentTranscriptsTable.agentSessionId,
        set: fillIfNullMetadataSet(),
      });
  }

  async function read(agentSessionId: ConversationId) {
    const rows = await db
      .select({
        harness: agentTranscriptsTable.harness,
        startedAt: agentTranscriptsTable.startedAt,
        cwd: agentTranscriptsTable.cwd,
      })
      .from(agentTranscriptsTable)
      .where(eq(agentTranscriptsTable.agentSessionId, agentSessionId))
      .limit(1);
    return rows[0];
  }

  afterAll(async () => {
    for (const id of scratchIds) {
      await db.delete(agentTranscriptsTable).where(eq(agentTranscriptsTable.agentSessionId, id));
    }
    await client.end({ timeout: 5 });
  });

  describe("mt#3342 — transcript metadata fill-if-null (real Postgres)", () => {
    test("AT1: a failure stub's placeholders are replaced by a later successful ingest", async () => {
      const id = scratchId("at1");

      // The failure stub, exactly as recordIngestFailure writes it: a non-null
      // 'unknown' harness sentinel and no started_at.
      await db
        .insert(agentTranscriptsTable)
        .values({ agentSessionId: id, harness: UNKNOWN_HARNESS, ingestFailureCount: 1 });

      const stub = await read(id);
      expect(stub?.harness).toBe(UNKNOWN_HARNESS);
      expect(stub?.startedAt).toBeNull();

      // A later successful ingest carrying real metadata.
      await upsert(id, { harness: REAL_HARNESS, startedAt: TRUE_START, cwd: "/tmp/mt3342-at1" });

      const repaired = await read(id);
      // Pre-fix, both of these kept the placeholder — that IS the bug.
      expect(repaired?.harness).toBe(REAL_HARNESS);
      expect(repaired?.startedAt?.getTime()).toBe(TRUE_START.getTime());
      expect(repaired?.cwd).toBe("/tmp/mt3342-at1");
    });

    test("AT2: a later batch does NOT regress an already-stored started_at", async () => {
      const id = scratchId("at2");

      await upsert(id, { harness: REAL_HARNESS, startedAt: TRUE_START });
      expect((await read(id))?.startedAt?.getTime()).toBe(TRUE_START.getTime());

      // An incremental ingest only sees lines since the high-water-mark, so its
      // derived startedAt is LATER than the true session start. Overwrite-always
      // would take it and silently walk every live conversation's start time
      // forward; fill-if-null must not.
      await upsert(id, { harness: REAL_HARNESS, startedAt: LATER_START });

      expect((await read(id))?.startedAt?.getTime()).toBe(TRUE_START.getTime());
    });

    test("a real harness is never clobbered by a later 'unknown' placeholder", async () => {
      const id = scratchId("harness");

      await upsert(id, { harness: REAL_HARNESS, startedAt: TRUE_START });
      // NULLIF keys off the STORED value, so a stored real harness must survive
      // even when the incoming row carries the sentinel.
      await upsert(id, { harness: UNKNOWN_HARNESS, startedAt: TRUE_START });

      expect((await read(id))?.harness).toBe(REAL_HARNESS);
    });
  });
} else {
  const missing: string[] = [];
  if (!process.env.RUN_INTEGRATION_TESTS) missing.push("RUN_INTEGRATION_TESTS=1");
  if (!BRANCH_URL) missing.push("SUPABASE_INTEGRATION_BRANCH_URL=<connection-string>");
  console.log(
    `[mt3342/fill-if-null] integration tests skipped — set ${missing.join(", ")} to run\n`
  );
}

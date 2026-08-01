/**
 * mt#3482 — the attachment insert's parent row, exercised against a REAL Postgres.
 *
 * ## Why this is an integration test rather than a unit test
 *
 * The defect IS a foreign-key constraint:
 * `agent_transcript_attachments.agent_session_id` references
 * `agent_transcripts.agent_session_id`, and the ingest writes attachments
 * BEFORE the transcript upsert that would create that parent row (deliberately,
 * per mt#3278 — writing them after the upsert would put them past the
 * high-water mark, where a failure is never retried). On a conversation's FIRST
 * ingest there was therefore no row to reference, so the insert violated the FK
 * and aborted the whole ingest.
 *
 * The ingest-service unit suite runs against a hand-rolled fake DB that records
 * statements without evaluating them — it cannot enforce an FK, so a unit test
 * asserting "the attachment insert succeeds" would pass no matter what the write
 * order was (the "check whose passing output is silence" shape). The unit suite
 * therefore pins the write ORDER
 * (`agent-transcript-ingest-service.test.ts` — "creates the parent transcript
 * row before inserting attachments on first ingest"), and this test pins the
 * constraint that makes the order matter.
 *
 * Skips (does not fail) without a database:
 *
 *   RUN_INTEGRATION_TESTS=1
 *   INTEGRATION_POSTGRES_URL=<postgres connection string>
 *
 * @see mt#3482 — the fix this guards
 * @see mt#3278 — why attachments are written before the transcript upsert
 * @see tests/integration/transcript-metadata-fill-if-null.integration.test.ts — sibling, same job
 */
import { describe, test, expect, afterAll } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { agentTranscriptsTable } from "@minsky/domain/storage/schemas/agent-transcripts-schema";
import { agentTranscriptAttachmentsTable } from "@minsky/domain/storage/schemas/agent-transcript-attachments-schema";
import type { ConversationId } from "@minsky/domain/ids";

const BRANCH_URL = process.env.INTEGRATION_POSTGRES_URL;

const REAL_HARNESS = "claude_code";
/** Postgres SQLSTATE for foreign_key_violation. */
const FK_VIOLATION = "23503";

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
    const id = `mt3482-it-${suffix}-${process.pid}-${scratchIds.length}` as ConversationId;
    scratchIds.push(id);
    return id;
  }

  /** One attachment row, shaped as `buildAttachmentRow` produces them. */
  function attachmentRow(agentSessionId: ConversationId, lineIndex: number) {
    return {
      agentSessionId,
      lineIndex,
      rawJsonlType: "attachment",
      attachmentType: "hook_additional_context",
      parentUuid: null,
      content: { type: "attachment", attachment: { type: "hook_additional_context" } },
      timestamp: new Date("2026-01-01T00:00:00.000Z"),
    };
  }

  /**
   * The parent-row insert exactly as §3a performs it: real metadata, and
   * deliberately NO `transcript` / `lastIngestedJsonlTimestamp` / `ingestedAt`
   * (the watermark must still advance only in the upsert).
   */
  async function insertParentRow(agentSessionId: ConversationId): Promise<void> {
    await db
      .insert(agentTranscriptsTable)
      .values({ agentSessionId, harness: REAL_HARNESS, cwd: "/tmp/mt3482" })
      .onConflictDoNothing();
  }

  afterAll(async () => {
    for (const id of scratchIds) {
      await db
        .delete(agentTranscriptAttachmentsTable)
        .where(eq(agentTranscriptAttachmentsTable.agentSessionId, id));
      await db.delete(agentTranscriptsTable).where(eq(agentTranscriptsTable.agentSessionId, id));
    }
    await client.end({ timeout: 5 });
  });

  describe("mt#3482 — attachment insert needs its parent transcript row (real Postgres)", () => {
    test("AT1: inserting an attachment for an unknown conversation violates the FK", async () => {
      // The pre-fix state: attachments written for a conversation that has no
      // agent_transcripts row yet. This is the failure 68 conversations hit in
      // 25h on 2026-07-31, and the reason the whole ingest aborted.
      const id = scratchId("no-parent");

      let caught: unknown;
      try {
        await db
          .insert(agentTranscriptAttachmentsTable)
          .values([attachmentRow(id, 0)])
          .onConflictDoNothing();
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      // Drizzle wraps the driver error, so the SQLSTATE can sit on the wrapper
      // or on its `cause` depending on the call path — read whichever carries
      // it rather than pinning one shape (measured: raw `postgres` puts 23503
      // on the error itself; `db.insert(...)` nests it under `cause`).
      const driverError = ((caught as { cause?: unknown }).cause ?? caught) as { code?: string };
      expect(driverError.code).toBe(FK_VIOLATION);
    });

    test("AT2: the same insert succeeds once the parent row exists", async () => {
      const id = scratchId("with-parent");

      await insertParentRow(id);
      await db
        .insert(agentTranscriptAttachmentsTable)
        .values([attachmentRow(id, 0)])
        .onConflictDoNothing();

      const rows = await db
        .select({ lineIndex: agentTranscriptAttachmentsTable.lineIndex })
        .from(agentTranscriptAttachmentsTable)
        .where(eq(agentTranscriptAttachmentsTable.agentSessionId, id));

      expect(rows.length).toBe(1);
    });

    test("AT3: the parent-row insert leaves the high-water mark unset", async () => {
      // §3a must not do the upsert's job. If it wrote a watermark, an attachment
      // failure after it would abort PAST the watermark and the batch would
      // never be retried — the exact loss mt#3278's ordering exists to prevent.
      const id = scratchId("no-watermark");

      await insertParentRow(id);

      const rows = await db
        .select({
          lastIngestedJsonlTimestamp: agentTranscriptsTable.lastIngestedJsonlTimestamp,
          transcript: agentTranscriptsTable.transcript,
          ingestFailureCount: agentTranscriptsTable.ingestFailureCount,
          harness: agentTranscriptsTable.harness,
        })
        .from(agentTranscriptsTable)
        .where(eq(agentTranscriptsTable.agentSessionId, id))
        .limit(1);

      expect(rows[0]?.lastIngestedJsonlTimestamp).toBeNull();
      expect(rows[0]?.transcript).toBeNull();
      // And the conversation starts with a clean failure budget rather than
      // burning 2 of INGEST_QUARANTINE_THRESHOLD before its first line lands.
      expect(rows[0]?.ingestFailureCount).toBe(0);
      // Real metadata, never a placeholder — a stub 'unknown' harness would be
      // pinned permanently by the upsert's fill-if-null group (mt#3342).
      expect(rows[0]?.harness).toBe(REAL_HARNESS);
    });

    test("AT4: re-running the parent-row insert is a no-op", async () => {
      const id = scratchId("idempotent");

      await insertParentRow(id);
      await insertParentRow(id);

      const rows = await db
        .select({ harness: agentTranscriptsTable.harness })
        .from(agentTranscriptsTable)
        .where(eq(agentTranscriptsTable.agentSessionId, id));

      expect(rows.length).toBe(1);
    });
  });
} else {
  const missing: string[] = [];
  if (!process.env.RUN_INTEGRATION_TESTS) missing.push("RUN_INTEGRATION_TESTS=1");
  if (!BRANCH_URL) missing.push("INTEGRATION_POSTGRES_URL=<connection-string>");
  console.log(
    `[mt3482/attachment-parent-row] integration tests skipped — set ${missing.join(", ")} to run\n`
  );
}

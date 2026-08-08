/**
 * mt#3836 — the writer-divergence verdict UPDATE, exercised against a REAL Postgres.
 *
 * ## Why this cannot be a unit test
 *
 * The defect was a TYPE ERROR in generated SQL. `persistDivergenceVerdict`
 * built its guard as `... IS DISTINCT FROM ${divergentTips}` with a JS array
 * interpolated into a `sql` template. Drizzle does not bind that as a `text[]`
 * — it expands the array into a comma-separated parameter list, so the
 * statement rendered `IS DISTINCT FROM ($4, $5)`, a ROW CONSTRUCTOR. Postgres
 * rejects `text[] IS DISTINCT FROM record`, the UPDATE threw on every call, and
 * the method's own `catch` swallowed it into a warn.
 *
 * The ingest-service unit suite runs against a hand-rolled fake DB that records
 * statements without evaluating them, so it cannot type-check SQL: the R1 unit
 * test asserting "the verdict is persisted on re-ingest" passed against a fake
 * that ignores the WHERE clause entirely, while the real write had never once
 * succeeded. That is the same shape as the defect this task exists to fix — a
 * double whose permissiveness hides a production failure — so the regression
 * belongs where the SQL is actually executed.
 *
 * Skips (does not fail) without a database:
 *
 *   RUN_INTEGRATION_TESTS=1
 *   INTEGRATION_POSTGRES_URL=<postgres connection string>
 *
 * @see mt#3836 — the fix this guards
 * @see mt#3656 — the detector whose verdict this write persists
 * @see tests/integration/transcript-attachment-parent-row.integration.test.ts — sibling, same job
 */
import { describe, test, expect, afterAll } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { agentTranscriptsTable } from "@minsky/domain/storage/schemas/agent-transcripts-schema";
import type { ConversationId } from "@minsky/domain/ids";

const BRANCH_URL = process.env.INTEGRATION_POSTGRES_URL;

if (process.env.RUN_INTEGRATION_TESTS && BRANCH_URL) {
  const client = postgres(BRANCH_URL, { max: 2 });
  const db = drizzle(client);
  const scratchIds: ConversationId[] = [];

  function scratchId(suffix: string): ConversationId {
    const id = `mt3836-it-${suffix}-${process.pid}-${scratchIds.length}` as ConversationId;
    scratchIds.push(id);
    return id;
  }

  /**
   * The guard exactly as `persistDivergenceVerdict` issues it. Kept verbatim
   * rather than importing the private method so this test exercises the SQL
   * SHAPE — which is what broke — against the real planner.
   */
  async function persistVerdict(
    agentSessionId: ConversationId,
    divergentTips: string[]
  ): Promise<void> {
    await db
      .update(agentTranscriptsTable)
      .set({ divergentTipLeaves: divergentTips, divergenceCheckedAt: new Date() })
      .where(
        and(
          eq(agentTranscriptsTable.agentSessionId, agentSessionId),
          sql`(${agentTranscriptsTable.divergenceCheckedAt} IS NULL
            OR array_to_string(${agentTranscriptsTable.divergentTipLeaves}, ',')
               IS DISTINCT FROM ${divergentTips.join(",")})`
        )
      );
  }

  async function readVerdict(agentSessionId: ConversationId) {
    const rows = await db
      .select({
        tips: agentTranscriptsTable.divergentTipLeaves,
        checkedAt: agentTranscriptsTable.divergenceCheckedAt,
      })
      .from(agentTranscriptsTable)
      .where(eq(agentTranscriptsTable.agentSessionId, agentSessionId));
    return rows[0];
  }

  async function insertRow(agentSessionId: ConversationId): Promise<void> {
    await db
      .insert(agentTranscriptsTable)
      .values({ agentSessionId, harness: "claude_code", cwd: "/tmp/mt3836" })
      .onConflictDoNothing();
  }

  afterAll(async () => {
    for (const id of scratchIds) {
      await db.delete(agentTranscriptsTable).where(eq(agentTranscriptsTable.agentSessionId, id));
    }
    await client.end({ timeout: 5 });
  });

  describe("mt#3836 — the divergence-verdict UPDATE executes against real Postgres", () => {
    test("AT1: writes both tips onto a never-checked row", async () => {
      const id = scratchId("never-checked");
      await insertRow(id);

      const tips = ["df8b0632-tip-a", "49eaa830-tip-b"];
      await persistVerdict(id, tips);

      const row = await readVerdict(id);
      expect(row?.tips).toEqual(tips);
      expect(row?.checkedAt).toBeInstanceOf(Date);
    });

    test("AT1: an empty verdict is recorded as checked, distinct from never-checked", async () => {
      const id = scratchId("clean");
      await insertRow(id);

      expect((await readVerdict(id))?.checkedAt).toBeNull();
      await persistVerdict(id, []);

      const row = await readVerdict(id);
      expect(row?.tips).toEqual([]);
      // The whole point of the paired timestamp: "the writers agreed" must be
      // distinguishable from "nothing has looked".
      expect(row?.checkedAt).toBeInstanceOf(Date);
    });

    test("an unchanged EMPTY verdict does not re-write either (PR #2708 R1)", async () => {
      // The costly case if it were wrong. Clean conversations are the vast
      // majority, and the sweep re-reads every quiet one on every tick — so an
      // empty verdict that failed to compare equal would re-write the entire
      // corpus, forever. It hinges on `array_to_string('{}', ',')` returning
      // '' rather than NULL, which is worth pinning against the real planner
      // rather than reasoning about.
      const id = scratchId("idempotent-empty");
      await insertRow(id);

      await persistVerdict(id, []);
      const first = await readVerdict(id);
      await persistVerdict(id, []);
      const second = await readVerdict(id);

      const firstAt = first?.checkedAt;
      const secondAt = second?.checkedAt;
      if (!(firstAt instanceof Date) || !(secondAt instanceof Date)) {
        throw new Error("expected both reads to carry a divergence_checked_at timestamp");
      }
      expect(secondAt.getTime()).toBe(firstAt.getTime());
    });

    test("an unchanged verdict does not re-write, so a quiet sweep stays idle", async () => {
      const id = scratchId("idempotent");
      await insertRow(id);

      const tips = ["tip-x", "tip-y"];
      await persistVerdict(id, tips);
      const first = await readVerdict(id);

      await persistVerdict(id, tips);
      const second = await readVerdict(id);

      // Same timestamp => the guard matched nothing the second time. This is
      // what keeps the sweep from writing once per conversation per tick.
      const firstAt = first?.checkedAt;
      const secondAt = second?.checkedAt;
      if (!(firstAt instanceof Date) || !(secondAt instanceof Date)) {
        throw new Error("expected both reads to carry a divergence_checked_at timestamp");
      }
      expect(secondAt.getTime()).toBe(firstAt.getTime());
    });

    test("a CHANGED verdict does re-write", async () => {
      const id = scratchId("changed");
      await insertRow(id);

      await persistVerdict(id, ["tip-1"]);
      await persistVerdict(id, ["tip-1", "tip-2"]);

      expect((await readVerdict(id))?.tips).toEqual(["tip-1", "tip-2"]);
    });
  });
}

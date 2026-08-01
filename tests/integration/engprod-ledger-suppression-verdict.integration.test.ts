/**
 * mt#3510 — suppression must not overwrite a filed proposal's verdict, exercised
 * against a REAL Postgres.
 *
 * ## Why this is an integration test rather than a unit test
 *
 * The defect IS an `ON CONFLICT DO UPDATE` set clause: the suppression upsert
 * took `verdict` straight from `EXCLUDED`, so a signature a previous run had
 * already filed as a proposal had its verdict overwritten to `suppressed` the
 * next time a suppression pass matched it. Measured in production 2026-07-31:
 * 10 filed proposals (mt#3419-mt#3428) carried `verdict = 'suppressed'` while
 * their tasks were still BLOCKED.
 *
 * The engprod unit suite runs against hand-rolled fake DBs that record
 * statements without evaluating them, so a unit test could only assert the
 * SHAPE of the SQL — a surrogate that passes as long as the string looks right
 * and cannot tell you what Postgres actually does with the CASE expression.
 * Since the fix IS the expression's evaluation, the assertion has to run in a
 * database that evaluates it.
 *
 * Skips (does not fail) without a database:
 *
 *   RUN_INTEGRATION_TESTS=1
 *   INTEGRATION_POSTGRES_URL=<postgres connection string>
 *
 * @see mt#3510 — the fix this guards
 * @see mt#3432 / mt#3429 — introduced the batched suppression write and its passes
 * @see tests/integration/transcript-attachment-parent-row.integration.test.ts — sibling, same job
 */
import { describe, test, expect, afterAll } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { engprodProposalLedgerTable } from "@minsky/domain/storage/schemas/engprod-proposal-ledger-schema";
import { ProposalLedgerService } from "@minsky/domain/engprod/ledger-service";
import type { MinedCluster } from "@minsky/domain/engprod/types";

const BRANCH_URL = process.env.INTEGRATION_POSTGRES_URL;

/** mt#3429 SC1 suppression reason — the pass that produced 6 of the 10 corrupted rows. */
const COLLAPSE_REASON = "non-maximal-subsequence";

if (process.env.RUN_INTEGRATION_TESTS && BRANCH_URL) {
  const client = postgres(BRANCH_URL, { max: 2 });
  const db = drizzle(client);
  const service = new ProposalLedgerService(db);
  const scratchSignatures: string[] = [];

  function scratchSignature(suffix: string): string {
    const sig = `mt3510-it-${suffix}-${process.pid}-${scratchSignatures.length}`;
    scratchSignatures.push(sig);
    return sig;
  }

  /** A mined cluster carrying DIFFERENT evidence than the seeded row, so a
   *  re-baselining bug is visible as a changed number rather than a no-op. */
  function cluster(signature: string): MinedCluster {
    return {
      signature,
      toolSequence: ["Bash", "Bash", "Bash"],
      frequency: 999,
      sessionCount: 99,
      chainLength: 3,
      score: 9.9,
      sampleRefs: [],
    } as MinedCluster;
  }

  /** Seed a row in the state a filed proposal is in: verdict + everProposed. */
  async function seedFiledRow(signature: string, verdict: string, filedTaskId: string) {
    const now = new Date();
    await db.insert(engprodProposalLedgerTable).values({
      clusterSignature: signature,
      verdict,
      rejectionReason: null,
      suppressedReason: null,
      toolSequence: ["Read", "Edit"],
      evidenceFrequency: 5,
      evidenceSessions: 2,
      evidenceChainLength: 2,
      evidenceSnapshot: { seeded: true },
      filedTaskId,
      everProposed: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  async function readRow(signature: string) {
    const rows = await db
      .select()
      .from(engprodProposalLedgerTable)
      .where(eq(engprodProposalLedgerTable.clusterSignature, signature))
      .limit(1);
    return rows[0];
  }

  afterAll(async () => {
    for (const sig of scratchSignatures) {
      await db
        .delete(engprodProposalLedgerTable)
        .where(eq(engprodProposalLedgerTable.clusterSignature, sig));
    }
    await client.end({ timeout: 5 });
  });

  describe("mt#3510 — suppression preserves a filed row's verdict (real Postgres)", () => {
    test("AT1: a batched suppression leaves verdict='proposed' intact and records the event", async () => {
      const sig = scratchSignature("proposed");
      await seedFiledRow(sig, "proposed", "mt#9001");

      await service.recordSuppressedBatch([
        {
          cluster: cluster(sig),
          suppressedReason: COLLAPSE_REASON,
          rejectionReason: "collapsed into a higher-ranked cluster",
        },
      ]);

      const row = await readRow(sig);
      // The defect: this read "suppressed" before the fix.
      expect(row?.verdict).toBe("proposed");
      expect(row?.filedTaskId).toBe("mt#9001");
      expect(row?.everProposed).toBe(true);

      // SC2: the suppression is still RECORDED rather than discarded.
      expect(row?.suppressedReason).toBe(COLLAPSE_REASON);
      expect(row?.lastSuppressedAt).not.toBeNull();
      expect(row?.suppressionCount).toBe(1);

      // Evidence is bound to the verdict and preserved with it — re-baselining
      // it would silently raise the re-surface threshold to match current
      // evidence, so the threshold could never fire.
      expect(row?.evidenceFrequency).toBe(5);
      expect(row?.evidenceSessions).toBe(2);
      expect(row?.toolSequence).toEqual(["Read", "Edit"]);
    });

    test("AT2: the same holds for accepted and rejected — this is what makes rejection durable", async () => {
      for (const verdict of ["accepted", "rejected"]) {
        const sig = scratchSignature(verdict);
        await seedFiledRow(sig, verdict, `mt#900-${verdict}`);

        await service.recordSuppressedBatch([
          {
            cluster: cluster(sig),
            suppressedReason: "low-distinctiveness",
            rejectionReason: "generic name-level cluster",
          },
        ]);

        const row = await readRow(sig);
        expect(row?.verdict).toBe(verdict);
        expect(row?.evidenceFrequency).toBe(5);
      }
    });

    test("AT1 (sibling path): the single-row budget-cap suppression preserves it too", async () => {
      // `recordSuppressedByBudget` goes through the OTHER upsert. It carried
      // the identical defect and is fixed in the same round.
      const sig = scratchSignature("budget");
      await seedFiledRow(sig, "proposed", "mt#9002");

      await service.recordSuppressedByBudget(cluster(sig));

      const row = await readRow(sig);
      expect(row?.verdict).toBe("proposed");
      expect(row?.suppressedReason).toBe("budget-cap");
      expect(row?.suppressionCount).toBe(1);
      expect(row?.evidenceFrequency).toBe(5);
    });

    test("a never-proposed signature is still suppressed normally — the fix is not a blanket freeze", async () => {
      // The 12,272 legitimately-suppressed rows in production have
      // everProposed=false. If the CASE guard fired for them too, the miner
      // would stop recording suppressions at all and this test would catch it.
      const sig = scratchSignature("fresh");

      await service.recordSuppressedBatch([
        {
          cluster: cluster(sig),
          suppressedReason: COLLAPSE_REASON,
          rejectionReason: "collapsed",
        },
      ]);

      const row = await readRow(sig);
      expect(row?.verdict).toBe("suppressed");
      expect(row?.everProposed).toBe(false);
      expect(row?.evidenceFrequency).toBe(999);
    });

    test("repeated suppressions accumulate the count rather than resetting it", async () => {
      const sig = scratchSignature("repeat");
      await seedFiledRow(sig, "proposed", "mt#9003");

      for (let i = 0; i < 3; i++) {
        await service.recordSuppressedBatch([
          {
            cluster: cluster(sig),
            suppressedReason: COLLAPSE_REASON,
            rejectionReason: "collapsed",
          },
        ]);
      }

      const row = await readRow(sig);
      expect(row?.suppressionCount).toBe(3);
      expect(row?.verdict).toBe("proposed");
    });
  });
} else {
  const missing: string[] = [];
  if (!process.env.RUN_INTEGRATION_TESTS) missing.push("RUN_INTEGRATION_TESTS=1");
  if (!BRANCH_URL) missing.push("INTEGRATION_POSTGRES_URL=<connection-string>");
  console.log(
    `[mt3510/ledger-suppression-verdict] integration tests skipped — set ${missing.join(", ")} to run\n`
  );
}

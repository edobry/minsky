#!/usr/bin/env bun
/**
 * One-time repair for mt#3510 — restore the verdict of filed proposals that a
 * suppression sweep overwrote.
 *
 * ## What went wrong
 *
 * The suppression upsert took `verdict` straight from `EXCLUDED`, so a cluster
 * signature a previous run had already filed as a proposal had its verdict
 * overwritten to `suppressed` the next time a suppression pass matched it.
 * Measured in production 2026-07-31: 10 rows (mt#3419-mt#3428), tasks still
 * BLOCKED. The write path is fixed in the same PR as this script; this repairs
 * the rows the old path already corrupted.
 *
 * ## Why the selection is exact rather than heuristic
 *
 * `ever_proposed` is set true only by a `proposed` write, and BOTH suppression
 * paths preserved it even while clobbering `verdict`. So
 * `ever_proposed = true AND verdict = 'suppressed'` is a contradiction that only
 * the bug could produce: a row that was filed as a proposal cannot legitimately
 * read `suppressed`. Every legitimately-suppressed row (12,272 of them in
 * production at the time of writing) carries `ever_proposed = false` and is
 * untouched by this script.
 *
 * ## What it restores to
 *
 * `verdict = 'proposed'`, NOT the row's original pre-overwrite verdict — that
 * value is not recoverable from the row. This is safe because `proposed` is the
 * verdict the reconciliation pass is designed to re-derive from: `reconcileVerdicts`
 * reads rows `WHERE verdict = 'proposed'` and re-derives accepted/rejected from
 * the filed task's CURRENT status. Restoring to `proposed` therefore hands each
 * row back to the mechanism that computes the right terminal verdict, rather
 * than guessing it here. (It is also the correct value on the evidence: all 10
 * tasks are still BLOCKED, i.e. untriaged.)
 *
 * The suppression that overwrote the row is NOT discarded — it is moved to the
 * columns that now carry it (`last_suppressed_at`, `suppression_count`), using
 * the row's own `updated_at` as the observed suppression time.
 *
 * ## Usage
 *
 *   bun scripts/repair-engprod-ledger-verdicts.ts              # dry run (default)
 *   bun scripts/repair-engprod-ledger-verdicts.ts --execute    # apply
 *
 * Requires a Postgres connection string in POSTGRES_URL or DATABASE_URL. Exits
 * 0 with a SKIP line when absent, so running it unattended is safe.
 *
 * @see mt#3510 — the bug, the fix, and this repair
 * @see packages/domain/src/engprod/ledger-service.ts — the fixed write path
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { engprodProposalLedgerTable } from "@minsky/domain/storage/schemas/engprod-proposal-ledger-schema";

const CONNECTION_URL = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
const EXECUTE = process.argv.includes("--execute");

/**
 * Operator-approved scope, from the mt#3510 spec's measured diagnosis. The
 * dry-run compares against this and REFUSES to proceed on divergence, per
 * `operational-safety-dry-run-first.mdc` §Dry-run scope-match check — approval
 * of a 10-row repair is not approval of a 90-row one.
 */
const APPROVED_ROW_COUNT = 10;
const SCOPE_DIVERGENCE_FACTOR = 2;

async function main(): Promise<number> {
  if (!CONNECTION_URL) {
    console.log("SKIP: neither POSTGRES_URL nor DATABASE_URL is set — nothing to do.");
    return 0;
  }

  const client = postgres(CONNECTION_URL, { max: 2 });
  const db = drizzle(client);

  try {
    const corrupted = await db
      .select({
        clusterSignature: engprodProposalLedgerTable.clusterSignature,
        filedTaskId: engprodProposalLedgerTable.filedTaskId,
        suppressedReason: engprodProposalLedgerTable.suppressedReason,
        updatedAt: engprodProposalLedgerTable.updatedAt,
        suppressionCount: engprodProposalLedgerTable.suppressionCount,
      })
      .from(engprodProposalLedgerTable)
      .where(
        and(
          eq(engprodProposalLedgerTable.everProposed, true),
          eq(engprodProposalLedgerTable.verdict, "suppressed")
        )
      );

    console.log(`${EXECUTE ? "EXECUTE" : "DRY RUN"} — repair engprod ledger verdicts (mt#3510)`);
    console.log(`Selector: ever_proposed = true AND verdict = 'suppressed'`);
    console.log(
      `Rows matched: ${corrupted.length} (operator-approved scope: ${APPROVED_ROW_COUNT})\n`
    );

    if (corrupted.length === 0) {
      console.log("Nothing to repair — no filed row carries a suppressed verdict.");
      return 0;
    }

    for (const row of corrupted) {
      console.log(
        `  ${row.filedTaskId ?? "(no task)"}  suppressed_reason=${row.suppressedReason ?? "-"}  ` +
          `overwritten_at=${row.updatedAt.toISOString()}  ->  verdict='proposed', ` +
          `last_suppressed_at=${row.updatedAt.toISOString()}, ` +
          `suppression_count=${(row.suppressionCount ?? 0) + 1}`
      );
    }
    console.log("");

    // Scope-match check: a repair much larger than what was approved means the
    // selector is matching something the diagnosis did not describe. Stop and
    // re-confirm rather than applying it.
    if (corrupted.length > APPROVED_ROW_COUNT * SCOPE_DIVERGENCE_FACTOR) {
      console.error(
        `REFUSING: ${corrupted.length} rows matched but only ~${APPROVED_ROW_COUNT} were approved ` +
          `(>${SCOPE_DIVERGENCE_FACTOR}x divergence). Re-confirm the scope before running with --execute.`
      );
      return 1;
    }

    if (!EXECUTE) {
      console.log("Dry run only. Re-run with --execute to apply:");
      console.log("  bun scripts/repair-engprod-ledger-verdicts.ts --execute");
      return 0;
    }

    // Preserve the suppression signal onto the columns that now carry it, using
    // the row's own updated_at as the observed suppression time. Done in ONE
    // statement so a partial repair cannot leave rows half-migrated.
    const updated = await db
      .update(engprodProposalLedgerTable)
      .set({
        verdict: "proposed",
        lastSuppressedAt: sql`COALESCE(${engprodProposalLedgerTable.lastSuppressedAt}, ${engprodProposalLedgerTable.updatedAt})`,
        suppressionCount: sql`${engprodProposalLedgerTable.suppressionCount} + 1`,
      })
      .where(
        and(
          eq(engprodProposalLedgerTable.everProposed, true),
          eq(engprodProposalLedgerTable.verdict, "suppressed")
        )
      )
      .returning({ filedTaskId: engprodProposalLedgerTable.filedTaskId });

    console.log(`Repaired ${updated.length} row(s).`);

    // Verify the OUTCOME, not the statement: re-read and confirm the
    // contradiction no longer exists.
    const remaining = await db
      .select({ clusterSignature: engprodProposalLedgerTable.clusterSignature })
      .from(engprodProposalLedgerTable)
      .where(
        and(
          eq(engprodProposalLedgerTable.everProposed, true),
          eq(engprodProposalLedgerTable.verdict, "suppressed")
        )
      );

    if (remaining.length > 0) {
      console.error(`FAILED: ${remaining.length} row(s) still corrupted after the update.`);
      return 1;
    }

    console.log("Verified: no filed row carries a suppressed verdict.");
    return 0;
  } finally {
    await client.end({ timeout: 5 });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("Repair failed:", err);
    process.exit(1);
  });

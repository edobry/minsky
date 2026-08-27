#!/usr/bin/env bun
/**
 * Live verification for guard-canary-history persistence (mt#4007).
 *
 * Exercises the full recordRun -> getGuardStatus round trip against the REAL
 * Postgres DB, using a synthetic guard name that will never collide with a
 * real one (`__mt4007_verify__`), and cleans up its own rows unconditionally.
 * Env-gated: skips gracefully when DATABASE_URL is absent, and reports (does
 * not crash on) a missing `guard_canary_runs` table — the expected state
 * before this task's migration (0093_low_scarlet_witch.sql) has been applied.
 *
 * This is the AT1 negative control, run for real:
 *   1. Two consecutive FAILING outcomes ("kill a guard's run() export") ->
 *      the store shows a contiguous-failure record whose brokenSinceAt is
 *      the FIRST of the two failure timestamps, not the second.
 *   2. A third, PASSING outcome ("restore") -> broken-since clears; status
 *      reads passing with the third run's timestamp.
 *   3. (AT3, folded in) every recordRun call leaves its own row — history,
 *      not last-write-wins; asserted by checking three distinct rows exist.
 *   4. (AT2) a guard name that was never recorded reads never-verified.
 *
 * Usage:
 *   DATABASE_URL=postgres://... bun scripts/verify-guard-canary-persistence.ts
 *
 * @see mt#4007 — this task
 * @see packages/domain/src/observability/guard-canary-history.ts — the module under test
 * @see scripts/smoke-presence-claims.ts — the sibling smoke script this mirrors
 */

import { getLoggableErrorSummary } from "@minsky/domain/errors/index";
import "reflect-metadata";

const VERIFY_GUARD_NAME = "__mt4007_verify__";
const NEVER_RECORDED_GUARD_NAME = "__mt4007_verify_never_recorded__";

function fail(message: string): never {
  console.error(`[verify-guard-canary-persistence] FAIL: ${message}`);
  process.exit(1);
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log("[verify-guard-canary-persistence] DATABASE_URL not set — skipping");
    process.exit(0);
  }

  console.log("[verify-guard-canary-persistence] Starting live verification...");

  const postgres = (await import("postgres")).default;
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { guardCanaryRunsTable } = await import(
    "../packages/domain/src/storage/schemas/guard-canary-runs-schema"
  );
  const { DrizzleGuardCanaryHistoryRepository } = await import(
    "../packages/domain/src/observability/guard-canary-history"
  );
  const { eq } = await import("drizzle-orm");

  const client = postgres(dbUrl, { max: 1 });
  const db = drizzle(client);
  const repo = new DrizzleGuardCanaryHistoryRepository(db);

  async function cleanup(): Promise<void> {
    await db
      .delete(guardCanaryRunsTable)
      .where(eq(guardCanaryRunsTable.guardName, VERIFY_GUARD_NAME));
  }

  try {
    // Table-existence check: report clearly rather than a raw pg error.
    try {
      await db.select().from(guardCanaryRunsTable).limit(1);
    } catch (err) {
      console.log(
        "[verify-guard-canary-persistence] guard_canary_runs table not found — " +
          "migration 0093_low_scarlet_witch.sql has not been applied yet (expected " +
          "pre-merge; the unmerged-migration guard blocks applying it to the shared " +
          "DB before this PR merges). Skipping.\n" +
          `  (${getLoggableErrorSummary(err)})`
      );
      await client.end();
      process.exit(0);
    }

    await cleanup(); // in case a prior aborted run left rows behind

    // ── AT2: a guard name that was never recorded is never-verified ────────
    console.log("[verify-guard-canary-persistence] 1. AT2 — never-recorded guard...");
    const neverVerified = await repo.getGuardStatus(NEVER_RECORDED_GUARD_NAME);
    if (neverVerified.state !== "never-verified") {
      fail(`expected never-verified, got ${JSON.stringify(neverVerified)}`);
    }
    console.log("  OK: never-verified (not conflated with passing)");

    // ── AT1: "kill a guard's run() export" — two contiguous failing runs ───
    console.log("[verify-guard-canary-persistence] 2. AT1 — two failing runs...");
    const t1 = new Date();
    await repo.recordRun(crypto.randomUUID(), t1, [
      {
        guardName: VERIFY_GUARD_NAME,
        source: "standalone",
        expects: "deny",
        passed: false,
        failureDetail: "run() threw: guard killed (verify script, run 1)",
      },
    ]);
    await new Promise((r) => setTimeout(r, 20));
    const t2 = new Date();
    await repo.recordRun(crypto.randomUUID(), t2, [
      {
        guardName: VERIFY_GUARD_NAME,
        source: "standalone",
        expects: "deny",
        passed: false,
        failureDetail: "run() threw: guard killed (verify script, run 2)",
      },
    ]);

    const broken = await repo.getGuardStatus(VERIFY_GUARD_NAME);
    if (broken.state !== "broken") {
      fail(`expected broken after two failing runs, got ${JSON.stringify(broken)}`);
    }
    if (broken.brokenSinceAt !== t1.toISOString()) {
      fail(
        `brokenSinceAt should be the FIRST failure's timestamp (${t1.toISOString()}), got ${broken.brokenSinceAt}`
      );
    }
    if (broken.lastCheckedAt !== t2.toISOString()) {
      fail(`lastCheckedAt should be the SECOND failure's timestamp, got ${broken.lastCheckedAt}`);
    }
    console.log(`  OK: broken, brokenSinceAt=${broken.brokenSinceAt} (the first failure)`);

    // ── AT1 continued: "restore, run again" — broken-since clears ──────────
    console.log("[verify-guard-canary-persistence] 3. AT1 — restore (passing run)...");
    await new Promise((r) => setTimeout(r, 20));
    const t3 = new Date();
    await repo.recordRun(crypto.randomUUID(), t3, [
      { guardName: VERIFY_GUARD_NAME, source: "standalone", expects: "deny", passed: true },
    ]);

    const passing = await repo.getGuardStatus(VERIFY_GUARD_NAME);
    if (passing.state !== "passing") {
      fail(`expected passing after restore, got ${JSON.stringify(passing)}`);
    }
    if (passing.lastVerifiedAt !== t3.toISOString()) {
      fail(`lastVerifiedAt should be the restore run's timestamp, got ${passing.lastVerifiedAt}`);
    }
    console.log(`  OK: passing, broken-since cleared (lastVerifiedAt=${passing.lastVerifiedAt})`);

    // ── AT3: history, not last-write-wins — three recordRun calls, three rows
    console.log("[verify-guard-canary-persistence] 4. AT3 — history is append-only...");
    const rows = await db
      .select()
      .from(guardCanaryRunsTable)
      .where(eq(guardCanaryRunsTable.guardName, VERIFY_GUARD_NAME));
    if (rows.length !== 3) {
      fail(`expected 3 distinct history rows (one per recordRun call), got ${rows.length}`);
    }
    console.log(`  OK: ${rows.length} distinct timestamped rows — no last-write-wins collapse`);

    console.log("[verify-guard-canary-persistence] All live checks passed.");
  } finally {
    await cleanup();
    await client.end();
  }
}

main().catch((err) => {
  console.error("[verify-guard-canary-persistence] FAILED:", err);
  process.exit(1);
});

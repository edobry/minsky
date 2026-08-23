#!/usr/bin/env bun
/**
 * Live verification that boot reconciliation PERSISTS its unrecoverable
 * verdict (mt#3269).
 *
 * Why a unit test is not enough. The tests for this inject
 * `persistTerminalVerdict`, so they prove the branch is TAKEN — not that the
 * default reaches a real database and the row actually changes. That gap is
 * mt#3254's lesson (a seam-tested binding rendered healthy zeros for five
 * weeks), and this change's failure mode is the same shape: a write that
 * silently never lands looks exactly like the status quo it was meant to fix.
 *
 * What it does:
 *   1. Seeds a throwaway non-terminal row with a NULL harness id — the
 *      permanently-unrecoverable shape.
 *   2. Runs the REAL `loadPersistedDrivenSessions()` against the real database,
 *      with no injected deps.
 *   3. Re-reads the seeded row and asserts it is now `unrecoverable`.
 *   4. Asserts it no longer appears in the boot query's result set.
 *   5. Removes the seeded row.
 *
 * NOTE: step 2 runs the real reconciliation, so it also processes any OTHER
 * non-terminal rows present — which is the fix operating as designed, not a
 * side effect of the probe.
 *
 * Usage (from the repo root):
 *
 *   bun scripts/verify-boot-verdict-persist.ts --i-understand-this-writes
 *
 * The flag is required because this probe WRITES to whatever database the
 * environment resolves — which for this repo is production. It seeds and then
 * removes its own row, but step 2 runs the real reconciliation, so it also
 * persists verdicts for any other permanently-unrecoverable rows present. That
 * is the fix operating as designed, and it is still a real state change that
 * should never happen by accident (PR #2383 R1).
 *
 * Exit codes: 0 = the verdict was persisted, 1 = failure (reason printed).
 */

// Must come first: the config bootstrap below pulls in tsyringe.
import "reflect-metadata";

// The daemon initializes configuration at boot; a standalone script must do it
// explicitly, or the database resolves null and the write silently no-ops —
// which would make this probe report a pass it did not earn. `process.cwd()`
// (repo root) is correct: that is where project/user config resolves from.
const { initializeConfiguration, CustomConfigFactory } = await import(
  "@minsky/domain/configuration"
);
await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

const { loadPersistedDrivenSessions } = await import("../src/cockpit/driven-session-launch");
const { getContextInspectorDb } = await import("../src/cockpit/db-providers");
const store = await import("@minsky/domain/transcripts/driven-session-registry-store");

const PROBE_ID = `mt3269-verdict-probe-${Date.now()}`;

function fail(reason: string): never {
  console.error(`FAIL: ${reason}`);
  process.exit(1);
}

if (!process.argv.includes("--i-understand-this-writes")) {
  console.error(
    "REFUSED: this probe writes to the configured database (production, in this repo).\n" +
      "It seeds and removes its own row, but it also runs the real boot reconciliation,\n" +
      "which persists verdicts for any other permanently-unrecoverable rows.\n" +
      "Re-run with --i-understand-this-writes if that is what you intend."
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const db = await getContextInspectorDb();
  if (!db) fail("no SQL persistence available — cannot verify the real binding");

  console.log(`[1/5] seeding a non-terminal row with a NULL harness id (${PROBE_ID})`);
  await store.upsertDrivenSessionRecord(db, {
    localId: PROBE_ID,
    harnessSessionId: null,
    cwd: "/tmp/mt3269-verdict-probe",
    permissionMode: "bypassPermissions",
    taskId: null,
    minskySessionId: null,
    status: "spawned",
    unrecoverableReason: null,
    pid: null,
    pidCmdline: null,
    model: null,
    driverGeneration: 0,
    startedAt: new Date().toISOString(),
  });

  const before = await store.getDrivenSessionRecord(db, PROBE_ID);
  if (before?.status !== "spawned") fail(`seed did not take — status is ${before?.status}`);
  console.log(`      seeded, status=${before.status}`);

  console.log("[2/5] running the REAL boot reconciliation (no injected deps)");
  const loaded = await loadPersistedDrivenSessions();
  console.log(`      reconciled ${loaded} row(s)`);

  console.log("[3/5] re-reading the seeded row from the database");
  const after = await store.getDrivenSessionRecord(db, PROBE_ID);
  console.log(`      status=${after?.status}, reason=${after?.unrecoverableReason ?? "(none)"}`);

  console.log("[4/5] confirming it drops out of the boot query");
  const stillRead = (await store.listNonTerminalDrivenSessions(db)).some(
    (r) => r.localId === PROBE_ID
  );
  console.log(`      appears in next boot's read: ${stillRead}`);

  console.log("[5/5] removing the probe row");
  await db.execute(
    (await import("drizzle-orm")).sql`DELETE FROM driven_sessions WHERE local_id = ${PROBE_ID}`
  );

  if (after?.status !== "unrecoverable") {
    fail(`the verdict was NOT persisted — status is still "${after?.status}"`);
  }
  if (stillRead) {
    fail("the row still appears in the boot query — it would reload forever");
  }

  console.log("PASS: the unrecoverable verdict was persisted and the row drops out of boot");
  process.exit(0);
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});

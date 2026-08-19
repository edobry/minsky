#!/usr/bin/env bun
/**
 * DRY-RUN report of which non-terminal `driven_sessions` rows boot
 * reconciliation would retire (mt#4255).
 *
 * Why a unit test is not enough. The tests for this inject `probeActuator`, so
 * they prove the BRANCH is taken for a given verdict — not that the real
 * predicate, run against the real process table and the real row set, produces
 * the verdicts anyone expects. That is the mt#3254 seam-tested-binding gap, and
 * this change's failure mode is the same shape in both directions: a probe that
 * always says "gone" retires the whole table, and one that always says "ours"
 * silently changes nothing while every test still passes.
 *
 * Two modes, and the default one writes nothing:
 *
 *   bun scripts/verify-actuator-gone-retirement.ts
 *       DRY RUN. Reads the live non-terminal rows through the same store
 *       function boot reconciliation uses, runs the REAL
 *       `probeProcessIdentity` on each row carrying a pid, and prints the
 *       per-row verdict plus totals — so the change count can be compared
 *       against what was approved before anything is applied.
 *
 *   bun scripts/verify-actuator-gone-retirement.ts --seed-probe
 *       WRITES, but only to a row it creates and then deletes. Seeds a
 *       throwaway row whose pid is definitely dead, runs the reconciler with
 *       ONLY `listNonTerminal` narrowed to that row — real database, real
 *       probe, real write — and asserts the row comes back `exited`, drops out
 *       of the boot query, and is NOT registered.
 *
 * Why the seeded mode exists rather than just running the real
 * `loadPersistedDrivenSessions()` the way scripts/verify-boot-verdict-persist.ts
 * does: that call processes EVERY non-terminal row, and this table's rows
 * include `principal-channel-standing`. Retiring the principal's live channel is
 * safe by construction (it stays resumable — see `persistActuatorGoneVerdict`),
 * but "safe by construction" is an argument, and doing it to his primary channel
 * before the change has been reviewed is not a call this script should make on
 * its own. Narrowing the row list is what makes the write binding testable
 * without that.
 *
 * Both branches are exercised, per `operational-safety-dry-run-first.mdc
 * §Dual-mode scripts` — a dry-run that passes is no evidence at all about the
 * branch that writes.
 *
 * Exit codes: 0 = pass, 1 = failure (reason printed). In dry-run a non-zero
 * retire count is a normal, expected result — it is what this exists to measure,
 * not a failure.
 *
 * Command lines are NEVER printed, only whether they matched: a process's argv
 * is world-readable and can carry a credential some other process passed
 * (`terminal-command-best-practices.mdc §Secret handling`), and this script's
 * output is persisted into the transcript.
 */

// Must come first: the config bootstrap below pulls in tsyringe.
import "reflect-metadata";

// The daemon initializes configuration at boot; a standalone script must do it
// explicitly, or the database resolves null and this reports an empty table it
// never actually looked at.
const { initializeConfiguration, CustomConfigFactory } = await import(
  "@minsky/domain/configuration"
);
await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

const { probeProcessIdentity } = await import("../src/cockpit/process-identity");
const { CLAUDE_BINARY } = await import("../src/cockpit/driven-session-host");
const { getContextInspectorDb } = await import("../src/cockpit/db-providers");
const store = await import("@minsky/domain/transcripts/driven-session-registry-store");

function fail(reason: string): never {
  console.error(`FAIL: ${reason}`);
  process.exit(1);
}

/**
 * The write-binding half: seed one throwaway row, reconcile ONLY that row with
 * every other dependency real, and assert the durable result.
 */
async function seedProbe(
  db: NonNullable<Awaited<ReturnType<typeof getContextInspectorDb>>>
): Promise<void> {
  const { reconcilePersistedDrivenSessions } = await import("../src/cockpit/driven-session-launch");
  const { DrivenSessionRegistry } = await import("../src/cockpit/driven-session-host");
  const { sql } = await import("drizzle-orm");

  const probeId = `mt4255-actuator-probe-${Date.now()}`;
  // Above every platform's pid ceiling, so the kernel answers ESRCH rather
  // than this racing whatever real process holds a plausible number.
  const DEAD_PID = 1_073_741_824;

  console.log(`[1/4] seeding a non-terminal row with a dead pid (${probeId})`);
  await store.upsertDrivenSessionRecord(db, {
    localId: probeId,
    harnessSessionId: `harness-${probeId}`,
    // A real, always-present directory: a missing cwd would classify the row
    // `unrecoverable` one branch earlier and this probe would never reach the
    // code it exists to test.
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    taskId: null,
    minskySessionId: null,
    status: "running",
    unrecoverableReason: null,
    pid: DEAD_PID,
    pidCmdline: `${CLAUDE_BINARY} -p --input-format stream-json`,
    model: null,
    actuatorGeneration: 0,
    startedAt: new Date().toISOString(),
  });

  console.log("[2/4] reconciling — real db, real probe, real write; row list narrowed to it");
  const registry = new DrivenSessionRegistry();
  const outcome = await reconcilePersistedDrivenSessions({
    listNonTerminal: async () => {
      const row = await store.getDrivenSessionRecord(db, probeId);
      return row ? [row] : [];
    },
    registry,
  });
  console.log(`      outcome=${JSON.stringify(outcome)}`);

  console.log("[3/4] re-reading the row and the boot query");
  const after = await store.getDrivenSessionRecord(db, probeId);
  const stillRead = (await store.listNonTerminalDrivenSessions(db)).some(
    (r) => r.localId === probeId
  );
  const registered = registry.get(probeId) !== undefined;
  console.log(
    `      status=${after?.status}, appears in next boot's read=${stillRead}, registered=${registered}`
  );

  console.log("[4/4] removing the probe row");
  await db.execute(sql`DELETE FROM driven_sessions WHERE local_id = ${probeId}`);

  if (after?.status !== "exited") {
    fail(`the actuator-gone verdict was NOT persisted — status is "${after?.status}"`);
  }
  if (stillRead) fail("the row still appears in the boot query — it would reload forever");
  if (registered) fail("the row was registered — the phantom would still render this boot");
  if (after.harnessSessionId !== `harness-${probeId}`) {
    fail("the write clobbered harnessSessionId — it must record a verdict, not rewrite the row");
  }
  if (after.unrecoverableReason !== null) {
    fail(
      "the write set unrecoverableReason — an actuator verdict makes no claim about the conversation"
    );
  }

  console.log(
    "\nPASS: a dead-actuator row is persisted `exited`, drops out of the boot query,\n" +
      "is not registered, and every other column survived the write."
  );
  process.exit(0);
}

async function main(): Promise<void> {
  const db = await getContextInspectorDb();
  if (!db) fail("no SQL persistence available — cannot read the live row set");

  if (process.argv.includes("--seed-probe")) {
    await seedProbe(db);
    return;
  }

  const rows = await store.listNonTerminalDrivenSessions(db);
  console.log(`Read ${rows.length} non-terminal row(s) — the set boot reconciliation loads.\n`);
  if (rows.length === 0) {
    console.log("Nothing to report.");
    process.exit(0);
  }

  let retire = 0;
  let keep = 0;
  let skipped = 0;

  for (const row of rows) {
    if (row.pid === null) {
      // Fails open in the reconciler too — there is nothing to probe.
      skipped += 1;
      console.log(`  KEEP     ${row.localId}  (no recorded pid)`);
      continue;
    }
    const verdict = await probeProcessIdentity(row.pid, row.pidCmdline ?? CLAUDE_BINARY);
    const wouldRetire = verdict === "gone" || verdict === "not-ours";
    if (wouldRetire) retire += 1;
    else keep += 1;
    console.log(
      `  ${wouldRetire ? "RETIRE" : "KEEP  "}   ${row.localId}  ` +
        `(status=${row.status}, pid=${row.pid}, verdict=${verdict})`
    );
  }

  console.log(
    `\nWould retire ${retire} of ${rows.length}; ` +
      `${keep} stay registered, ${skipped} skipped for want of a pid.`
  );
  console.log("No rows were modified — this script writes nothing.");
  console.log(
    "The write happens at daemon boot, in `reconcilePersistedDrivenSessions`.\n" +
      "`not-ours` means the pid is ALIVE but belongs to an unrelated process (pid reuse);\n" +
      "`unknown` means the probe could not answer, and that row is deliberately kept."
  );
  process.exit(0);
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});

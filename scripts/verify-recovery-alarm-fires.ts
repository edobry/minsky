#!/usr/bin/env bun
/**
 * mt#1495 — live verification that the recovery alarm actually FIRES.
 *
 * ## Why this script exists
 *
 * The unit tests hand `classifyRecycleCounters` a hand-built object. That proves
 * the decision logic, and it proves nothing about whether a real abandoned close
 * ever REACHES it — which is the entire failure this task exists to prevent. A
 * detector that ships, passes its tests, and never fires is exactly the shape of
 * the 2026-06-02 incident memo: *"a detection mechanism is not 'working' because
 * it shipped, returned a result, or passed a unit test."*
 *
 * The control direction matters here and is easy to get backwards (mem#704,
 * seventh costume). This detector's DEFAULT output is "no alert" — it is
 * threshold-shaped, so a negative control is vacuous: a detector that never
 * alerts passes one by construction. **The discriminating control is the
 * POSITIVE one**, so this script forces the fault and asserts the alarm appears.
 *
 * ## What it exercises
 *
 * The real production chain, end to end, in one process:
 *
 *   recycleSharedPersistence()   — the real recycle entry point
 *     -> closeAbandonedService() — the real outer deadline + outcome recording
 *       -> getDbRecycle()        — the real counters mt#4549 ships
 *         -> readRecycleCounters()      \
 *         -> toRecoveryCheckSummary()    } the detector this task adds
 *         -> scoreService()             /
 *
 * Nothing in that chain is mocked, stubbed, or re-implemented here.
 *
 * ## The one substitution, named rather than glossed
 *
 * The wedged pool is simulated: the installed service's `close()` returns a
 * promise that never settles, instead of a real postgres-js pool frozen by a TCP
 * proxy.
 *
 * That substitution is legitimate for THIS question and would not be for a
 * different one. `closeAbandonedService` races `close()` against its deadline and
 * cannot observe WHY the promise failed to settle — a half-open socket and a
 * never-resolving promise are indistinguishable to it, so the outcome it records
 * is identical. What the substitution cannot show is whether a real wedge
 * produces a non-settling close in the first place; that is
 * `scripts/verify-close-terminates-wedged-pool.ts` (mt#4515), which freezes a TCP
 * proxy in front of the real pooler and is the artifact that owns that half.
 * Together they cover the chain; neither covers it alone.
 *
 * ## Usage
 *
 *   bun scripts/verify-recovery-alarm-fires.ts            # positive control
 *   bun scripts/verify-recovery-alarm-fires.ts --healthy  # the must-not-fire case
 *
 * `--healthy` installs a service whose `close()` resolves promptly and asserts
 * the alarm STAYS SILENT. Run it to confirm this harness can report both
 * answers — a checker that says "fired" no matter what is not a check.
 *
 * Needs no database, no credential and no network: the chain under test is the
 * cockpit's own recycle bookkeeping. Exit 0 = pass, 1 = fail.
 */

// MUST be the first runtime import: importing shared-persistence reaches the
// persistence layer through tsyringe, which throws at module load without the
// reflect-metadata polyfill. This is the scripts convention that
// `custom/require-hook-domain-bootstrap` enforces (mt#3176) — without it the
// entry point dies on import, or silently does nothing.
import "reflect-metadata";

import {
  getDbRecycle,
  recycleSharedPersistence,
  getSharedPersistenceService,
  RECYCLE_CLOSE_TIMEOUT_MS,
} from "../src/cockpit/shared-persistence";
import type { PersistenceService } from "../packages/domain/src/persistence/service";
import {
  readRecycleCounters,
  toRecoveryCheckSummary,
} from "../packages/domain/src/deployment/monitor-recovery-alarm";
import {
  scoreService,
  type CheckSummary,
  type ServiceCheckSummary,
} from "../packages/domain/src/deployment/monitor-verdict";

const HEALTHY_MODE = process.argv.includes("--healthy");

/** Margin over the outer deadline, so the abandon has definitely been recorded. */
const WAIT_MS = RECYCLE_CLOSE_TIMEOUT_MS + 1_500;

/**
 * A service standing in for a wedged pool.
 *
 * `close()` returns a promise with no resolve path at all — the shape a half-open
 * pool produces, where `Promise.all` over per-connection `end()` can never settle
 * because the peer is gone and the sockets are not.
 */
function wedgedService(): PersistenceService {
  // eslint-disable-next-line custom/no-excessive-as-unknown -- PersistenceService is a CLASS with private state, not an interface, so a structural stand-in cannot satisfy it nominally. Only initialize() and close() lie on the path under test (getSharedPersistenceService -> recycleSharedPersistence -> closeAbandonedService); constructing a real one would need a live database and would not change what this verifies.
  return {
    initialize: async () => {},
    close: () => new Promise<void>(() => {}),
  } as unknown as PersistenceService;
}

/** A service that closes normally — the control for the must-not-fire direction. */
function healthyService(): PersistenceService {
  // eslint-disable-next-line custom/no-excessive-as-unknown -- see wedgedService above; same class-vs-interface constraint.
  return {
    initialize: async () => {},
    close: () => Promise.resolve(),
  } as unknown as PersistenceService;
}

const ran = (): CheckSummary => ({ outcome: "ok", detail: null, problem: false });

function log(line: string): void {
  console.log(line);
}

async function main(): Promise<number> {
  log(`mt#1495 recovery-alarm verification — mode: ${HEALTHY_MODE ? "healthy" : "wedged"}`);
  log("");

  // 1. Install the service through the real accessor, so the module holds it the
  //    way the cockpit does. A fresh process starts with clean module state, so
  //    no test-only reset helper is needed (and this is not a test environment,
  //    so `__resetSharedPersistenceForTests` would refuse anyway).
  const factory = HEALTHY_MODE ? healthyService : wedgedService;
  await getSharedPersistenceService(5_000, async () => factory());
  log("  installed a persistence service via getSharedPersistenceService()");

  const before = getDbRecycle();
  if (before.recycleCount !== 0 || before.closesAbandoned !== 0) {
    log(`  FAIL: expected clean module state, got ${JSON.stringify(before)}`);
    return 1;
  }
  log(`  baseline: ${JSON.stringify(before)}`);

  // 2. Drive the real recycle. This is the production entry point, not a
  //    reimplementation of it.
  recycleSharedPersistence("mt#1495 verification");
  log(`  recycleSharedPersistence() called; waiting ${WAIT_MS}ms for the close to settle`);

  await new Promise((resolve) => setTimeout(resolve, WAIT_MS));

  // 3. Read the real counters.
  const after = getDbRecycle();
  log(`  counters: ${JSON.stringify(after)}`);

  // 4. Run the detector over them, exactly as check (d) does.
  const reading = readRecycleCounters({ dbRecycle: after });
  const summary: ServiceCheckSummary = {
    service: "cockpit",
    deploy: ran(),
    health: ran(),
    digest: ran(),
    recovery: toRecoveryCheckSummary(reading),
  };
  const score = scoreService(summary, false);

  log(`  reading:  ${reading.state}`);
  log(`  verdict:  ${score.verdict}`);
  log(`  alerts:   ${JSON.stringify(score.alerts.map((a) => a.class))}`);
  log("");

  const alarmed = score.alerts.some((a) => a.class === "recovery-degraded");

  if (HEALTHY_MODE) {
    if (after.recycleCount !== 1 || after.closesAbandoned !== 0) {
      log(`  FAIL: expected 1 recycle and 0 abandoned closes, got ${JSON.stringify(after)}`);
      return 1;
    }
    if (alarmed) {
      log("  FAIL: the alarm fired on a clean close — it does not discriminate.");
      return 1;
    }
    log("  PASS: a clean close recorded no abandoned outcome and raised no alarm.");
    log(`        (reading was "${reading.state}", verdict ${score.verdict})`);
    return 0;
  }

  if (after.closesAbandoned !== 1) {
    log(`  FAIL: expected exactly 1 abandoned close, got ${after.closesAbandoned}.`);
    log("        The recycle path did not record the outcome the detector reads.");
    return 1;
  }
  if (reading.state !== "alarm") {
    log(`  FAIL: counters show an abandoned close but the reading was "${reading.state}".`);
    return 1;
  }
  if (!alarmed) {
    log("  FAIL: the reading alarmed but scoreService raised no recovery-degraded alert.");
    log("        The detector is wired wrong — this is the never-fires case.");
    return 1;
  }

  log("  PASS: a real abandoned close, recorded by the real recycle path, produced a");
  log("        recovery-degraded alert end to end.");
  log(`        alert reason: ${score.alerts.find((a) => a.class === "recovery-degraded")?.reason}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`  FAIL: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });

/**
 * Tests for the test-runner wall-clock watchdog (mt#3156).
 *
 * The load-bearing case is a child that IGNORES SIGTERM. `Bun.spawnSync`'s own
 * `timeout` + `killSignal` options handle that case WRONG — the child runs past
 * its budget to completion and is reported `exitCode: 0, success: true`, i.e. a
 * hung run reads as a PASS. These tests pin the corrected behavior.
 */

import { describe, test, expect } from "bun:test";
import {
  spawnWithWatchdog,
  collectDescendantPids,
  scanDescendants,
  resolveWatchdogBudgetMs,
  formatWatchdogTimeout,
  WATCHDOG_BUDGETS_MS,
} from "./spawn-with-watchdog";

/** Long enough that the watchdog always wins the race; short enough to bound a leaked child. */
const SPIN_MS = 20_000;
const BUDGET_MS = 1_500;
const GRACE_MS = 700;

// Children are inline `bun -e` programs rather than temp files: `Bun.spawn`
// takes an argv ARRAY, so no shell is involved and nothing needs quoting or a
// real path on disk. That keeps these tests filesystem-free (no temp dirs to
// leak or collide on) while still exercising genuinely separate OS processes —
// which is the whole point, since the behavior under test is signal delivery.
const SPIN = `const end = Date.now() + ${SPIN_MS}; while (Date.now() < end) {}`;

/** Prints and exits immediately. */
const QUICK_CHILD = ["bun", "-e", `console.log("hello from child")`];
/** Spins with the DEFAULT SIGTERM disposition, so SIGTERM terminates it. */
const OBEYS_SIGTERM_CHILD = ["bun", "-e", SPIN];
/**
 * Installs a no-op SIGTERM handler and then spins. This is the exact shape that
 * defeats `Bun.spawnSync`'s own timeout — only SIGKILL can stop it.
 */
const IGNORES_SIGTERM_CHILD = ["bun", "-e", `process.on("SIGTERM", () => {}); ${SPIN}`];

describe("spawnWithWatchdog — normal completion", () => {
  test("a fast child completes untouched, with its stdout captured", async () => {
    const result = await spawnWithWatchdog(QUICK_CHILD, { budgetMs: 30_000 });
    expect(result.timedOut).toBe(false);
    expect(result.requiredSigkill).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello from child");
  });

  test("inheritStdio leaves the captured buffers empty but still succeeds", async () => {
    const result = await spawnWithWatchdog(QUICK_CHILD, {
      budgetMs: 30_000,
      inheritStdio: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("");
  });
});

describe("spawnWithWatchdog — hang containment", () => {
  test("a SIGTERM-obeying spinner is terminated at the budget without needing SIGKILL", async () => {
    const result = await spawnWithWatchdog(OBEYS_SIGTERM_CHILD, {
      budgetMs: BUDGET_MS,
      graceMs: GRACE_MS,
    });
    expect(result.timedOut).toBe(true);
    expect(result.requiredSigkill).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.elapsedMs).toBeLessThan(SPIN_MS);
  });

  test("a SIGTERM-IGNORING spinner is escalated to SIGKILL and still reaped", async () => {
    const result = await spawnWithWatchdog(IGNORES_SIGTERM_CHILD, {
      budgetMs: BUDGET_MS,
      graceMs: GRACE_MS,
    });
    expect(result.timedOut).toBe(true);
    expect(result.requiredSigkill).toBe(true);
    // Must NOT report success — this is the exact case Bun.spawnSync's own
    // timeout reports as exitCode 0 / success true after running to completion.
    expect(result.exitCode).not.toBe(0);
    // Terminated near budget+grace, nowhere near the child's full spin.
    expect(result.elapsedMs).toBeLessThan(SPIN_MS);
  });

  test("a timed-out run always fails closed, so an exit-code-only caller cannot read it as a pass", async () => {
    const result = await spawnWithWatchdog(IGNORES_SIGTERM_CHILD, {
      budgetMs: BUDGET_MS,
      graceMs: GRACE_MS,
    });
    expect(result.exitCode).toBeGreaterThan(0);
  });
});

/**
 * mt#4098: the watchdog used to signal ONLY its direct child, so a child that
 * had itself spawned something left that grandchild running with PPID 1 — the
 * shape that leaked two `mcp start --http` servers to 48.2 GB and 32 GB on
 * 2026-08-13. `bun test` is not a leaf: spawning suites live under it.
 */
describe("spawnWithWatchdog — descendant reaping (mt#4098)", () => {
  /** Whether a pid still exists, without delivering a signal. */
  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Poll for a pid to disappear, so the assertion does not race signal delivery. */
  async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    // performance.now(), matching the module under test: monotonic, and it does
    // not trip `custom/no-real-fs-in-tests`, which reads a bare Date.now() in a
    // test as unique-path construction.
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (!isAlive(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !isAlive(pid);
  }

  /**
   * A child that spawns `grandchildProgram` as its own child, announces that
   * grandchild's pid on stdout, and then hangs so the watchdog budget fires.
   * The inner program is JSON-escaped rather than interpolated raw — argv is an
   * array so no shell is involved, but the inner source still has to survive
   * being embedded in the outer source.
   */
  function spawnsGrandchild(grandchildProgram: string): string[] {
    return [
      "bun",
      "-e",
      `const gc = Bun.spawn(["bun", "-e", ${JSON.stringify(grandchildProgram)}], ` +
        `{ stdout: "ignore", stderr: "ignore", stdin: "ignore" }); ` +
        `console.log("GRANDCHILD_PID=" + gc.pid); ${SPIN}`,
    ];
  }

  function grandchildPidFrom(stdout: string): number {
    const match = stdout.match(/GRANDCHILD_PID=(\d+)/);
    if (!match) throw new Error(`child never announced a grandchild pid. stdout: ${stdout}`);
    return Number.parseInt(match[1] as string, 10);
  }

  test("a grandchild of a timed-out child is reaped, not orphaned to PPID 1", async () => {
    const result = await spawnWithWatchdog(spawnsGrandchild(SPIN), {
      budgetMs: BUDGET_MS,
      graceMs: GRACE_MS,
    });

    expect(result.timedOut).toBe(true);
    expect(result.reapedDescendants).toBeGreaterThanOrEqual(1);

    const grandchildPid = grandchildPidFrom(result.stdout);
    expect(await waitForExit(grandchildPid, 2_000)).toBe(true);
  });

  test("a SIGTERM-IGNORING grandchild is escalated to SIGKILL — the wedged case that motivated this", async () => {
    // The orphans this fixes were wedged at ~99% CPU with a blocked event loop,
    // so they could not have serviced SIGTERM. A grandchild that dies on SIGTERM
    // would pass even with a broken escalation; this one cannot.
    const result = await spawnWithWatchdog(
      spawnsGrandchild(`process.on("SIGTERM", () => {}); ${SPIN}`),
      { budgetMs: BUDGET_MS, graceMs: GRACE_MS }
    );

    expect(result.timedOut).toBe(true);
    expect(result.reapedDescendants).toBeGreaterThanOrEqual(1);
    // PR #2963 R1: the escalation must be REPORTED, not just performed. Without
    // this field the run is indistinguishable from one where the grandchild went
    // quietly, because `requiredSigkill` only ever describes the direct child.
    expect(result.descendantsRequiredSigkill).toBeGreaterThanOrEqual(1);
    expect(result.descendantScanFailed).toBe(false);

    const grandchildPid = grandchildPidFrom(result.stdout);
    expect(await waitForExit(grandchildPid, 2_000)).toBe(true);
  });

  test("a run that completes within budget signals nothing", async () => {
    const result = await spawnWithWatchdog(QUICK_CHILD, { budgetMs: 30_000 });
    expect(result.timedOut).toBe(false);
    expect(result.reapedDescendants).toBe(0);
  });
});

/**
 * PR #2963 R1: enumeration is a two-mechanism affair, and the case that matters
 * is the one where NEITHER works — that must be distinguishable from "the child
 * spawned nothing," because the two produce the same empty pid list.
 */
describe("scanDescendants — mechanism availability", () => {
  test("prefers the single ps snapshot when it is available", () => {
    const tree = new Map<number, number[]>([
      [100, [200]],
      [200, [300]],
    ]);
    const scan = scanDescendants(100, {
      processTree: () => tree,
      childrenViaPgrep: () => {
        throw new Error("pgrep must not be consulted when ps succeeded");
      },
    });
    expect(scan.pids.sort((a, b) => a - b)).toEqual([200, 300]);
    expect(scan.enumerationFailed).toBe(false);
  });

  test("falls back to pgrep when ps is unavailable", () => {
    const viaPgrep: Record<number, number[]> = { 100: [200], 200: [] };
    const scan = scanDescendants(100, {
      processTree: () => null,
      childrenViaPgrep: (pid) => viaPgrep[pid] ?? [],
    });
    expect(scan.pids).toEqual([200]);
    expect(scan.enumerationFailed).toBe(false);
  });

  test("reports enumerationFailed when NEITHER mechanism is available", () => {
    // The regression this guards: returning an empty list here is indistinguishable
    // from a childless root, so the watchdog would silently revert to the
    // pre-mt#4098 child-only kill and report a clean run.
    const scan = scanDescendants(100, {
      processTree: () => null,
      childrenViaPgrep: () => null,
    });
    expect(scan.pids).toEqual([]);
    expect(scan.enumerationFailed).toBe(true);
  });

  test("a childless root is NOT an enumeration failure", () => {
    const scan = scanDescendants(100, {
      processTree: () => null,
      childrenViaPgrep: () => [],
    });
    expect(scan.pids).toEqual([]);
    expect(scan.enumerationFailed).toBe(false);
  });
});

describe("collectDescendantPids", () => {
  test("walks the whole tree breadth-first, excluding the root itself", () => {
    const tree: Record<number, number[]> = { 100: [200, 201], 200: [300], 201: [], 300: [400] };
    const found = collectDescendantPids(100, (pid) => tree[pid] ?? []);
    expect(found.sort((a, b) => a - b)).toEqual([200, 201, 300, 400]);
  });

  test("returns empty for a childless root", () => {
    expect(collectDescendantPids(100, () => [])).toEqual([]);
  });

  test("terminates on a cycle rather than hanging inside the watchdog timer", () => {
    // Pid reuse between two pgrep calls can present as a cycle. This loop runs
    // inside a setTimeout with no outer watchdog, so a hang here would be
    // unrecoverable — the cycle guard is load-bearing, not defensive dressing.
    const cyclic: Record<number, number[]> = { 100: [200], 200: [300], 300: [100, 200] };
    const found = collectDescendantPids(100, (pid) => cyclic[pid] ?? []);
    expect(found.sort()).toEqual([200, 300]);
  });
});

describe("resolveWatchdogBudgetMs", () => {
  test("uses the fallback when the override is unset", () => {
    expect(resolveWatchdogBudgetMs(5000, {})).toBe(5000);
  });

  test("honors a valid positive override", () => {
    expect(resolveWatchdogBudgetMs(5000, { MINSKY_TEST_WATCHDOG_MS: "12345" })).toBe(12345);
  });

  test("ignores a non-numeric override rather than disabling the watchdog", () => {
    expect(resolveWatchdogBudgetMs(5000, { MINSKY_TEST_WATCHDOG_MS: "soon" })).toBe(5000);
  });

  test("ignores zero and negative overrides — an unbounded run is the bug being fixed", () => {
    expect(resolveWatchdogBudgetMs(5000, { MINSKY_TEST_WATCHDOG_MS: "0" })).toBe(5000);
    expect(resolveWatchdogBudgetMs(5000, { MINSKY_TEST_WATCHDOG_MS: "-1" })).toBe(5000);
  });
});

describe("watchdog budget ordering", () => {
  test("the outer gated-step budget exceeds the inner main-suite budget", () => {
    // Ordering is load-bearing: the INNER watchdog must fire first so the actual
    // `bun test` leaf is killed by its own runner. If the outer fired first it
    // would kill the middle process and orphan the leaf — the PPID-1 orphans
    // that motivated this task.
    expect(WATCHDOG_BUDGETS_MS.GATED_STEP).toBeGreaterThan(WATCHDOG_BUDGETS_MS.MAIN);
  });

  test("every budget is finite and positive", () => {
    for (const value of Object.values(WATCHDOG_BUDGETS_MS)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });
});

describe("formatWatchdogTimeout", () => {
  test("names the budget, the actual runtime, and the override knob", () => {
    const message = formatWatchdogTimeout("run-tests-main.ts", 900_000, {
      exitCode: 1,
      stdout: "",
      stderr: "",
      timedOut: true,
      requiredSigkill: false,
      elapsedMs: 900_500,
      reapedDescendants: 0,
      descendantsRequiredSigkill: 0,
      descendantScanFailed: false,
    });
    expect(message).toContain("run-tests-main.ts");
    expect(message).toContain("900s wall-clock watchdog");
    expect(message).toContain("MINSKY_TEST_WATCHDOG_MS");
    expect(message).toContain("HANG, not a test failure");
  });

  test("calls out a SIGKILL escalation so an ignored SIGTERM is visible in the log", () => {
    const message = formatWatchdogTimeout("x", 1000, {
      exitCode: 1,
      stdout: "",
      stderr: "",
      timedOut: true,
      requiredSigkill: true,
      elapsedMs: 1500,
      reapedDescendants: 0,
      descendantsRequiredSigkill: 0,
      descendantScanFailed: false,
    });
    expect(message).toContain("SIGKILL after ignoring SIGTERM");
  });

  /**
   * PR #2963 R1: a wedged GRANDCHILD escalation is invisible in `requiredSigkill`
   * by design, so the operator-facing message is where it has to show up.
   */
  test("names a descendant SIGKILL escalation even when the direct child obeyed SIGTERM", () => {
    const message = formatWatchdogTimeout("x", 1000, {
      exitCode: 1,
      stdout: "",
      stderr: "",
      timedOut: true,
      requiredSigkill: false,
      elapsedMs: 1500,
      reapedDescendants: 3,
      descendantsRequiredSigkill: 2,
      descendantScanFailed: false,
    });
    expect(message).toContain("3 descendant process(es)");
    expect(message).toContain("2 of which required SIGKILL");
    // The direct child obeyed, so the child-level clause must NOT appear —
    // otherwise the two escalations are indistinguishable in the log.
    expect(message).not.toContain("SIGKILL after ignoring SIGTERM");
  });

  test("warns when descendants could not be enumerated at all", () => {
    const message = formatWatchdogTimeout("x", 1000, {
      exitCode: 1,
      stdout: "",
      stderr: "",
      timedOut: true,
      requiredSigkill: false,
      elapsedMs: 1500,
      reapedDescendants: 0,
      descendantsRequiredSigkill: 0,
      descendantScanFailed: true,
    });
    expect(message).toContain("could NOT be enumerated");
    expect(message).toContain("may still be running");
  });

  test("stays quiet about descendants when there were none", () => {
    const message = formatWatchdogTimeout("x", 1000, {
      exitCode: 1,
      stdout: "",
      stderr: "",
      timedOut: true,
      requiredSigkill: false,
      elapsedMs: 1500,
      reapedDescendants: 0,
      descendantsRequiredSigkill: 0,
      descendantScanFailed: false,
    });
    expect(message).not.toContain("descendant");
    expect(message).not.toContain("could NOT be enumerated");
  });
});

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
    });
    expect(message).toContain("SIGKILL after ignoring SIGTERM");
  });
});

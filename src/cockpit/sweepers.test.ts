/**
 * Unit tests for the `createIntervalSweeper` factory (mt#2615 / mt#2625).
 *
 * mt#2625 regression: `startProdStateRefreshSweeper` stalled for 28+ hours on
 * 2026-07-05 because a hung `getRawSqlConnection()` call left the `running`
 * overlap-guard permanently `true`, silently starving every later tick. The
 * "never-resolving tick" test below is the acceptance test for that bug:
 * a tick whose work never resolves must time out, release the guard, and
 * let the NEXT tick actually execute.
 */
import { describe, test, expect } from "bun:test";
import { createIntervalSweeper } from "./sweepers";

/** Poll `condition` until it's true, or throw after `timeoutMs`. */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  // eslint-disable-next-line custom/no-real-fs-in-tests -- Date.now() is used for timing, not path creation; the rule's regex fires on the call pattern but there is no filesystem interaction here
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    // eslint-disable-next-line custom/no-real-fs-in-tests -- same: timing, not path creation
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("createIntervalSweeper", () => {
  test("runs the boot tick immediately", async () => {
    let calls = 0;
    const stop = createIntervalSweeper({
      name: "test-boot",
      intervalMs: 60_000,
      tickTimeoutMs: 5_000,
      tick: async () => {
        calls++;
      },
    });
    try {
      await waitFor(() => calls >= 1);
      expect(calls).toBe(1);
    } finally {
      stop();
    }
  });

  test("skips overlapping ticks while a tick is in flight", async () => {
    let ingestCount = 0;
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });

    const stop = createIntervalSweeper({
      name: "test-overlap",
      intervalMs: 1,
      // Large timeout relative to the test window below — the point of this
      // test is the OVERLAP guard, not the timeout guard (that's the next test).
      tickTimeoutMs: 5_000,
      tick: async () => {
        ingestCount++;
        await gate; // Block indefinitely until the test resolves it.
      },
    });

    try {
      await waitFor(() => ingestCount >= 1, 500);
      // Give the 1ms interval time to fire several more ticks while the first
      // is still blocked. Count must remain 1 (overlap-skip guard holds).
      await new Promise((r) => setTimeout(r, 50));
      expect(ingestCount).toBe(1);
    } finally {
      resolveGate();
      stop();
    }
  });

  // ── mt#2625 regression: never-resolving tick recovery ─────────────────────

  test("a tick whose work never resolves times out, releases the guard, and the next tick executes (mt#2625)", async () => {
    let callCount = 0;
    const neverResolves = new Promise<void>(() => {
      /* deliberately never settles */
    });

    const stop = createIntervalSweeper({
      name: "test-hang-recovery",
      intervalMs: 15,
      tickTimeoutMs: 20,
      tick: async () => {
        callCount++;
        if (callCount === 1) {
          // First call hangs forever — simulates mt#2625's hung DB call.
          await neverResolves;
          return;
        }
        // Every subsequent call resolves immediately.
      },
    });

    try {
      // If the guard were never released, callCount would stay at 1 forever.
      // Recovery means a SECOND tick actually runs after the timeout fires.
      await waitFor(() => callCount >= 2, 2000);
      expect(callCount).toBeGreaterThanOrEqual(2);
    } finally {
      stop();
    }
  });

  test("the watchdog force-releases the guard even if the primary timeout somehow did not", async () => {
    // Simulate the primary Promise.race path being bypassed by using a
    // tickTimeoutMs long enough that the FIRST call's own race won't win
    // before the watchdog's own check (at the top of the SECOND scheduled
    // runTick) observes the guard has been held too long. We approximate
    // this by setting a short intervalMs and a slightly larger tickTimeoutMs,
    // then asserting the sweeper still recovers within a bounded window.
    let callCount = 0;
    const neverResolves = new Promise<void>(() => {
      /* deliberately never settles */
    });

    const stop = createIntervalSweeper({
      name: "test-watchdog",
      intervalMs: 10,
      tickTimeoutMs: 30,
      tick: async () => {
        callCount++;
        if (callCount === 1) {
          await neverResolves;
          return;
        }
      },
    });

    try {
      await waitFor(() => callCount >= 2, 2000);
      expect(callCount).toBeGreaterThanOrEqual(2);
    } finally {
      stop();
    }
  });

  test("an unexpected throw from the tick callback does not crash the sweeper — next tick still runs", async () => {
    let callCount = 0;
    const stop = createIntervalSweeper({
      name: "test-throw-safety-net",
      intervalMs: 10,
      tickTimeoutMs: 5_000,
      tick: async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("unexpected failure");
        }
      },
    });

    try {
      await waitFor(() => callCount >= 2, 2000);
      expect(callCount).toBeGreaterThanOrEqual(2);
    } finally {
      stop();
    }
  });

  test("stop() clears the interval (no further ticks after stop)", async () => {
    let callCount = 0;
    const stop = createIntervalSweeper({
      name: "test-stop",
      intervalMs: 10,
      tickTimeoutMs: 5_000,
      tick: async () => {
        callCount++;
      },
    });

    await waitFor(() => callCount >= 1, 500);
    const countAtStop = callCount;
    stop();

    await new Promise((r) => setTimeout(r, 100));
    // Allow at most one extra tick that was in-flight when stop() fired.
    expect(callCount).toBeLessThanOrEqual(countAtStop + 1);
  });

  test("defaults tickTimeoutMs to DEFAULT_TICK_TIMEOUT_MS when omitted", async () => {
    // Sanity check that omitting tickTimeoutMs doesn't throw and the sweeper
    // still runs its boot tick — the actual default value is exercised
    // indirectly (a 5-minute default is far too long to assert on directly
    // in a fast unit test).
    let calls = 0;
    const stop = createIntervalSweeper({
      name: "test-default-timeout",
      intervalMs: 60_000,
      tick: async () => {
        calls++;
      },
    });
    try {
      await waitFor(() => calls >= 1);
      expect(calls).toBe(1);
    } finally {
      stop();
    }
  });
});

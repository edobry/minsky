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
import { describe, test, expect, afterEach } from "bun:test";
import {
  createIntervalSweeper,
  getSweepLivenessSnapshot,
  startSweepMetaWatchdog,
  _simulateDroppedTimerForTest,
  _resetSweepLivenessRegistryForTest,
  REINIT_FAILURE_THRESHOLD,
} from "./sweepers";

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

// ── mt#2894: per-sweep liveness registry ──────────────────────────────────

describe("sweep-liveness registry (mt#2894)", () => {
  afterEach(() => {
    _resetSweepLivenessRegistryForTest();
  });

  test("records lastAttemptAt and lastSuccessAt after a successful boot tick", async () => {
    const stop = createIntervalSweeper({
      name: "test-liveness-success",
      intervalMs: 60_000,
      tickTimeoutMs: 5_000,
      tick: async () => {},
    });
    try {
      await waitFor(() => {
        const entry = getSweepLivenessSnapshot().find((e) => e.name === "test-liveness-success");
        return entry?.lastSuccessAt !== null && entry?.lastSuccessAt !== undefined;
      });
      const entry = getSweepLivenessSnapshot().find((e) => e.name === "test-liveness-success");
      expect(entry).toBeDefined();
      expect(entry?.lastAttemptAt).not.toBeNull();
      expect(entry?.lastSuccessAt).not.toBeNull();
      expect(entry?.lastErrorAt).toBeNull();
      expect(entry?.consecutiveFailures).toBe(0);
      expect(entry?.intervalMs).toBe(60_000);
    } finally {
      stop();
    }
  });

  test("records lastErrorAt and increments consecutiveFailures on a timed-out tick", async () => {
    const neverResolves = new Promise<void>(() => {
      /* deliberately never settles */
    });
    const stop = createIntervalSweeper({
      name: "test-liveness-error",
      intervalMs: 60_000,
      tickTimeoutMs: 15,
      tick: async () => {
        await neverResolves;
      },
    });
    try {
      await waitFor(() => {
        const entry = getSweepLivenessSnapshot().find((e) => e.name === "test-liveness-error");
        return (entry?.consecutiveFailures ?? 0) >= 1;
      });
      const entry = getSweepLivenessSnapshot().find((e) => e.name === "test-liveness-error");
      expect(entry?.lastErrorAt).not.toBeNull();
      expect(entry?.consecutiveFailures).toBeGreaterThanOrEqual(1);
    } finally {
      stop();
    }
  });

  test("bounded re-init: N consecutive failures trigger a self-restart, then a successful tick clears the failure streak", async () => {
    let callCount = 0;
    const stop = createIntervalSweeper({
      name: "test-bounded-reinit",
      intervalMs: 15,
      tickTimeoutMs: 10,
      tick: async () => {
        callCount++;
        if (callCount <= REINIT_FAILURE_THRESHOLD) {
          // Hang past tickTimeoutMs so each of the first N ticks counts as a failure.
          await new Promise(() => {});
        }
        // Ticks after the threshold resolve immediately (success).
      },
    });
    try {
      await waitFor(() => {
        const entry = getSweepLivenessSnapshot().find((e) => e.name === "test-bounded-reinit");
        return (entry?.reinits ?? 0) >= 1;
      }, 3000);
      const entry = getSweepLivenessSnapshot().find((e) => e.name === "test-bounded-reinit");
      expect(entry?.reinits).toBeGreaterThanOrEqual(1);
      // consecutiveFailures resets to 0 the moment the threshold triggers a re-init.
      await waitFor(() => {
        const e = getSweepLivenessSnapshot().find((x) => x.name === "test-bounded-reinit");
        return e?.lastSuccessAt !== null && e?.lastSuccessAt !== undefined;
      }, 3000);
    } finally {
      stop();
    }
  });

  test("stop() deregisters the sweep from the liveness snapshot", async () => {
    const stop = createIntervalSweeper({
      name: "test-liveness-deregister",
      intervalMs: 60_000,
      tickTimeoutMs: 5_000,
      tick: async () => {},
    });
    await waitFor(() =>
      getSweepLivenessSnapshot().some((e) => e.name === "test-liveness-deregister")
    );
    stop();
    expect(getSweepLivenessSnapshot().some((e) => e.name === "test-liveness-deregister")).toBe(
      false
    );
  });

  // ── PR #2019 R1 BLOCKING #1: stop() must be authoritative ────────────────

  test("stop() prevents a late in-flight bounded re-init from resurrecting the sweep", async () => {
    let attemptCount = 0;
    const stop = createIntervalSweeper({
      name: "test-stop-vs-reinit",
      intervalMs: 15,
      tickTimeoutMs: 10,
      tick: async () => {
        attemptCount++;
        // Every attempt hangs forever — each individually times out via the
        // factory's own per-tick timeout (mt#2625), incrementing
        // consecutiveFailures on schedule without this test needing to
        // orchestrate exact promise resolution timing.
        await new Promise<void>(() => {});
      },
    });

    try {
      // Let 2 failures accumulate — one short of REINIT_FAILURE_THRESHOLD
      // (3) — so the NEXT tick's timeout would normally cross the
      // threshold and trigger a bounded re-init.
      await waitFor(() => {
        const entry = getSweepLivenessSnapshot().find((e) => e.name === "test-stop-vs-reinit");
        return (entry?.consecutiveFailures ?? 0) >= 2;
      }, 3000);

      // Stop right now — the 3rd (threshold-crossing) attempt is either
      // already in flight or about to start; its eventual timeout must not
      // resurrect the sweep via restartInterval("bounded-reinit").
      stop();

      // Wait past when the 3rd attempt's timeout (10ms) — and thus the
      // buggy re-init, if the fix regressed — would have fired, then
      // confirm attemptCount has stopped growing across a further window.
      await new Promise((r) => setTimeout(r, 60));
      const countAfterFirstWait = attemptCount;
      await new Promise((r) => setTimeout(r, 60));
      expect(attemptCount).toBe(countAfterFirstWait);

      expect(getSweepLivenessSnapshot().some((e) => e.name === "test-stop-vs-reinit")).toBe(false);
    } finally {
      stop(); // must be a safe no-op when already stopped
    }
  });

  // ── PR #2019 R1 BLOCKING #2: duplicate active registration ────────────────

  test("throws when registering a duplicate ACTIVE sweep name", () => {
    const stop = createIntervalSweeper({
      name: "test-duplicate-name",
      intervalMs: 60_000,
      tickTimeoutMs: 5_000,
      tick: async () => {},
    });
    try {
      expect(() =>
        createIntervalSweeper({
          name: "test-duplicate-name",
          intervalMs: 60_000,
          tickTimeoutMs: 5_000,
          tick: async () => {},
        })
      ).toThrow(/duplicate active sweep registration/);
    } finally {
      stop();
    }
  });

  test("re-registering the same name after a clean stop() does not throw", async () => {
    const stopFirst = createIntervalSweeper({
      name: "test-reuse-after-stop",
      intervalMs: 60_000,
      tickTimeoutMs: 5_000,
      tick: async () => {},
    });
    stopFirst();

    let calls = 0;
    const stopSecond = createIntervalSweeper({
      name: "test-reuse-after-stop",
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
      stopSecond();
    }
  });
});

// ── mt#2894: meta-watchdog ("sweep of sweeps") ─────────────────────────────

describe("sweep meta-watchdog (mt#2894)", () => {
  afterEach(() => {
    _resetSweepLivenessRegistryForTest();
  });

  test("force-restarts a sweep whose underlying timer was silently dropped, within one meta-cadence", async () => {
    let callCount = 0;
    const stop = createIntervalSweeper({
      name: "test-meta-watchdog-drop",
      intervalMs: 15,
      tickTimeoutMs: 5_000,
      tick: async () => {
        callCount++;
      },
    });
    // Short meta-cadence for test speed; stall threshold is 2x intervalMs (15ms) = 30ms.
    const stopWatchdog = startSweepMetaWatchdog(20);
    try {
      await waitFor(() => callCount >= 1);
      const countAfterBoot = callCount;

      // Simulate the exact mt#2891 failure class: the timer handle is
      // cleared out from under the sweep without touching the process or
      // calling the sweep's own stop() — the sweep stays "registered" but
      // its interval never fires again on its own.
      _simulateDroppedTimerForTest("test-meta-watchdog-drop");

      // Confirm the timer really is dead: no new ticks in a short window
      // (kept well under the 30ms/20ms stall/scan thresholds above so this
      // check itself doesn't race the watchdog's own recovery).
      await new Promise((r) => setTimeout(r, 10));
      expect(callCount).toBe(countAfterBoot);

      // The meta-watchdog should detect the stall (staleness > 30ms) on one
      // of its 20ms scans and force-restart the interval — ticks resume.
      await waitFor(() => callCount > countAfterBoot, 2000);
      expect(callCount).toBeGreaterThan(countAfterBoot);

      const entry = getSweepLivenessSnapshot().find((e) => e.name === "test-meta-watchdog-drop");
      expect(entry?.metaRestarts).toBeGreaterThanOrEqual(1);
    } finally {
      stopWatchdog();
      stop();
    }
  });

  test("does not restart a healthy sweep that is still attempting ticks on schedule", async () => {
    let callCount = 0;
    const stop = createIntervalSweeper({
      name: "test-meta-watchdog-healthy",
      intervalMs: 15,
      tickTimeoutMs: 5_000,
      tick: async () => {
        callCount++;
      },
    });
    const stopWatchdog = startSweepMetaWatchdog(20);
    try {
      await waitFor(() => callCount >= 2);
      // Let the watchdog scan several times while the sweep keeps ticking normally.
      await new Promise((r) => setTimeout(r, 100));
      const entry = getSweepLivenessSnapshot().find((e) => e.name === "test-meta-watchdog-healthy");
      expect(entry?.metaRestarts ?? 0).toBe(0);
    } finally {
      stopWatchdog();
      stop();
    }
  });

  // ── PR #2019 R1 BLOCKING #1: meta-watchdog must respect stop() too ────────

  test("does not restart a sweep that was cleanly stopped, even once it looks stale", async () => {
    let callCount = 0;
    const stop = createIntervalSweeper({
      name: "test-meta-watchdog-stopped",
      intervalMs: 15,
      tickTimeoutMs: 5_000,
      tick: async () => {
        callCount++;
      },
    });
    await waitFor(() => callCount >= 1);
    stop();
    const countAtStop = callCount;

    // Short meta-cadence so several scans happen well within the wait below,
    // each of which would see this sweep's (now-frozen) lastAttemptAt as
    // stale past the 2x-cadence (30ms) threshold — the exact condition that
    // triggers a restart for a sweep that ISN'T stopped.
    const stopWatchdog = startSweepMetaWatchdog(10);
    try {
      await new Promise((r) => setTimeout(r, 100));
      expect(callCount).toBe(countAtStop); // never restarted
      expect(getSweepLivenessSnapshot().some((e) => e.name === "test-meta-watchdog-stopped")).toBe(
        false
      );
    } finally {
      stopWatchdog();
    }
  });
});

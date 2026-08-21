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
  registerSelfSchedulingSweep,
  getSweepLivenessSnapshot,
  startSweepMetaWatchdog,
  _simulateDroppedTimerForTest,
  _resetSweepLivenessRegistryForTest,
  REINIT_FAILURE_THRESHOLD,
  runProdStateRefreshTick,
  runAskStateRefreshTick,
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

  // ── mt#4335: an abandoned tick must not run CONCURRENTLY with its successor ──
  //
  // The defect this pins is not "the guard is never released" (mt#2625 above
  // covers that) — it is the opposite. On timeout the guard was released while
  // the abandoned tick was STILL RUNNING, so the next tick started beside it.
  // Each overlapping tick opens its own database connection, and the abandoned
  // one is never cancelled, so a persistently-slow tick leaks roughly one
  // connection per cycle. Measured 2026-08-19: 16 backends in
  // `state='active', wait_event='ClientRead'`, opened in a single ~40s burst.
  //
  // The observable here is CONCURRENCY, which is the framework-level cause;
  // the stranded connection is its consequence one layer down. Asserting on
  // concurrency keeps the test deterministic and free of a live Postgres.
  test("an overrunning tick is not run concurrently with the next tick (mt#4335)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let starts = 0;

    // Timings matter here and are chosen against the two deadlines, not picked
    // round. The first tick must overrun `tickTimeoutMs` (so it IS abandoned)
    // while settling comfortably before
    // `tickTimeoutMs * ABANDONED_TICK_HARD_RELEASE_MULTIPLIER` (so the
    // watchdog's ceiling does NOT fire and this test exercises the settle path
    // rather than the force-release path). 50 / 100 / 150 gives 50ms of margin
    // on both sides.
    const TICK_TIMEOUT_MS = 50;
    const FIRST_TICK_MS = 100; // > timeout, < 150ms ceiling
    const stop = createIntervalSweeper({
      name: "test-abandoned-no-overlap",
      intervalMs: 20,
      tickTimeoutMs: TICK_TIMEOUT_MS,
      tick: async () => {
        starts++;
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        try {
          if (starts === 1) await new Promise((r) => setTimeout(r, FIRST_TICK_MS));
        } finally {
          inFlight--;
        }
      },
    });

    try {
      // Wait past the first tick's settle plus several further intervals, so a
      // regression has ample opportunity to start a second tick alongside it.
      await waitFor(() => starts >= 2, 2000);
      await new Promise((r) => setTimeout(r, 60));
      expect(maxInFlight).toBe(1);
      // The abandonment DID happen — otherwise this test would also pass on a
      // build where the tick simply never overran, proving nothing (mem#704).
      const snap = getSweepLivenessSnapshot().find((s) => s.name === "test-abandoned-no-overlap");
      expect(snap?.abandonedTicks).toBeGreaterThanOrEqual(1);
      // It settled on its own, so nothing is left outstanding and the ceiling
      // never had to fire.
      expect(snap?.abandonedTicksOutstanding).toBe(0);
      expect(snap?.abandonedTickHardReleases).toBe(0);
    } finally {
      stop();
    }
  });

  test("an abandoned tick that NEVER settles is still force-released at the ceiling (mt#4335 keeps mt#2625)", async () => {
    // The complement of the test above, and the reason the ceiling exists:
    // holding the guard until settle would starve the sweep forever if the
    // tick never settles, which is precisely the mt#2625 bug. The ceiling
    // bounds the wait instead of removing it.
    let starts = 0;
    const neverResolves = new Promise<void>(() => {
      /* deliberately never settles */
    });

    const stop = createIntervalSweeper({
      name: "test-abandoned-hard-release",
      intervalMs: 10,
      tickTimeoutMs: 20, // ceiling = 60ms
      tick: async () => {
        starts++;
        if (starts === 1) await neverResolves;
      },
    });

    try {
      await waitFor(() => starts >= 2, 2000);
      expect(starts).toBeGreaterThanOrEqual(2);
      const snap = getSweepLivenessSnapshot().find((s) => s.name === "test-abandoned-hard-release");
      // The distinguishing counter: this one never settled, so it was released
      // by the ceiling rather than by its own completion.
      expect(snap?.abandonedTickHardReleases).toBeGreaterThanOrEqual(1);
      expect(snap?.abandonedTicksOutstanding).toBeGreaterThanOrEqual(1);
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

  // ── mt#3060: force-restart must fire a tick, not just re-arm the timer ────
  //
  // Regression for the 2026-07-22 incident (mt#3051's runtime-log evidence):
  // the meta-watchdog fired "force-restarting" once a minute for ~7.5h and
  // `staleMs` never reset. Root cause: `restartInterval` only called
  // `startInterval()` (re-arm) and never `runTick()` (fire) — so whenever a
  // sweep's own cadence is LONGER than the watchdog's scan cadence (every
  // real production sweep: e.g. prod-state's 10min vs the watchdog's 60s
  // default), the watchdog re-clobbers the freshly-armed interval on its
  // very next scan, before that interval ever gets a chance to fire on its
  // own — an infinite restart storm that never actually resumes ticking.
  // The prior test above ("force-restarts ... within one meta-cadence") used
  // intervalMs=15ms < watchdog cadence=20ms, which masked this bug: the
  // restarted interval's OWN natural cadence elapsed before the next scan,
  // so it "happened" to tick anyway. This test deliberately inverts that
  // ratio to match production.
  test("force-restart resumes real ticking even when the sweep's cadence outlasts the watchdog's scan interval", async () => {
    let callCount = 0;
    const stop = createIntervalSweeper({
      name: "test-meta-watchdog-restart-storm",
      // Sweep cadence is intentionally much LONGER than the watchdog's scan
      // cadence below (500ms vs 20ms) — the exact ratio every real sweep has
      // relative to DEFAULT_META_WATCHDOG_INTERVAL_MS, and the ratio the
      // pre-fix bug needed to manifest as an infinite restart storm.
      intervalMs: 500,
      tickTimeoutMs: 5_000,
      tick: async () => {
        callCount++;
      },
    });
    const stopWatchdog = startSweepMetaWatchdog(20); // stall threshold = 2 * 500ms = 1000ms
    try {
      await waitFor(() => callCount >= 1);
      const countAfterBoot = callCount;

      _simulateDroppedTimerForTest("test-meta-watchdog-restart-storm");

      // Wait for at least one force-restart to fire (staleness > 1000ms).
      await waitFor(() => {
        const entry = getSweepLivenessSnapshot().find(
          (e) => e.name === "test-meta-watchdog-restart-storm"
        );
        return (entry?.metaRestarts ?? 0) >= 1;
      }, 3000);

      // The actual regression check: a restart must produce a REAL tick
      // shortly after, not just increment metaRestarts while callCount stays
      // frozen (which is what the pre-fix restart-storm looked like — the
      // watchdog kept "restarting" every 20ms scan without ever letting a
      // tick actually run before the next scan clobbered it again).
      await waitFor(() => callCount > countAfterBoot, 2000);
      expect(callCount).toBeGreaterThan(countAfterBoot);

      // mt#3060 AT2: the liveness signal (the scheduling-layer equivalent of
      // ProdStateSweepTracker — ProdStateSweepTracker itself only tracks the
      // DOMAIN outcome of an attempted tick, so it can't observe a tick that
      // never got attempted at all) must demonstrably reflect BOTH the
      // failure (a force-restart was recorded) AND the recovery (a fresh
      // successful tick landed after it).
      const finalEntry = getSweepLivenessSnapshot().find(
        (e) => e.name === "test-meta-watchdog-restart-storm"
      );
      expect(finalEntry?.metaRestarts ?? 0).toBeGreaterThanOrEqual(1);
      expect(finalEntry?.lastSuccessAt).not.toBeNull();
    } finally {
      stopWatchdog();
      stop();
    }
  });
});

/**
 * Domain-outcome reporting (mt#3684).
 *
 * The defect these pin is a READING, not a crash: on 2026-08-06 the prod-state
 * sweep failed every tick for 13 hours while `/api/sweeps` showed a fresh
 * `lastSuccessAt` and `consecutiveFailures: 0`. That entry was not wrong about
 * what it measures — the timer was firing and the callback was returning — it
 * was answering a different question from the one a reader asks.
 */
describe("sweep domain-outcome reporting (mt#3684)", () => {
  afterEach(() => {
    _resetSweepLivenessRegistryForTest();
  });

  function entryFor(name: string) {
    return getSweepLivenessSnapshot().find((e) => e.name === name);
  }

  test("a reported domain failure is visible while the scheduling fields stay truthful (AT1)", async () => {
    const stop = createIntervalSweeper({
      name: "test-domain-failure",
      intervalMs: 60_000,
      tickTimeoutMs: 5_000,
      // The shape the tick contract asks for: handle your own error, return
      // normally — and now also say that the work did not succeed.
      tick: async () => ({ ok: false }),
    });
    try {
      await waitFor(() => (entryFor("test-domain-failure")?.consecutiveDomainFailures ?? 0) >= 1);
      const entry = entryFor("test-domain-failure");

      expect(entry?.reportsDomainOutcome).toBe(true);
      expect(entry?.lastDomainFailureAt).not.toBeNull();
      expect(entry?.consecutiveDomainFailures).toBe(1);
      expect(entry?.lastDomainSuccessAt).toBeNull();

      // The contrast IS the fix. Scheduling succeeded — the timer fired and the
      // callback returned — and saying so remains correct (mt#2894). What
      // changed is that it is no longer the ONLY thing the surface says.
      expect(entry?.lastSuccessAt).not.toBeNull();
      expect(entry?.consecutiveFailures).toBe(0);
    } finally {
      stop();
    }
  });

  test("negative control: the same tick reporting nothing leaves the failure invisible (AT2)", async () => {
    // This is the pre-fix surface, and what an operator read for 13 hours.
    const stop = createIntervalSweeper({
      name: "test-domain-silent",
      intervalMs: 60_000,
      tickTimeoutMs: 5_000,
      tick: async () => {
        /* handled its own failure and said nothing — the old contract */
      },
    });
    try {
      await waitFor(() => entryFor("test-domain-silent")?.lastSuccessAt != null);
      const entry = entryFor("test-domain-silent");

      expect(entry?.reportsDomainOutcome).toBe(false);
      expect(entry?.lastDomainFailureAt).toBeNull();
      expect(entry?.lastDomainSuccessAt).toBeNull();
      expect(entry?.consecutiveDomainFailures).toBe(0);
      // Indistinguishable from a healthy sweep on every field that exists.
      expect(entry?.lastSuccessAt).not.toBeNull();
      expect(entry?.consecutiveFailures).toBe(0);
    } finally {
      stop();
    }
  });

  test("a reported domain success records one and resets the failure run (AT6)", async () => {
    const stop = createIntervalSweeper({
      name: "test-domain-success",
      intervalMs: 60_000,
      tickTimeoutMs: 5_000,
      tick: async () => ({ ok: true }),
    });
    try {
      await waitFor(() => entryFor("test-domain-success")?.lastDomainSuccessAt != null);
      const entry = entryFor("test-domain-success");

      expect(entry?.reportsDomainOutcome).toBe(true);
      expect(entry?.lastDomainSuccessAt).not.toBeNull();
      expect(entry?.lastDomainFailureAt).toBeNull();
      expect(entry?.consecutiveDomainFailures).toBe(0);
    } finally {
      stop();
    }
  });

  test("a domain failure does not count toward the bounded re-init (AT3)", async () => {
    // Re-init recovers a WEDGED tick. mt#3682 established that restarting the
    // interval is a no-op against a failure below the sweep, so restarting the
    // timer because the database is unreachable would add churn with no path to
    // recovery — the behavior mt#3826 exists to stop.
    const stop = createIntervalSweeper({
      name: "test-domain-no-reinit",
      intervalMs: 15,
      tickTimeoutMs: 5_000,
      tick: async () => ({ ok: false }),
    });
    try {
      await waitFor(
        () =>
          (entryFor("test-domain-no-reinit")?.consecutiveDomainFailures ?? 0) >
          REINIT_FAILURE_THRESHOLD
      );
      const entry = entryFor("test-domain-no-reinit");

      expect(entry?.consecutiveDomainFailures).toBeGreaterThan(REINIT_FAILURE_THRESHOLD);
      expect(entry?.reinits).toBe(0);
      expect(entry?.consecutiveFailures).toBe(0);
    } finally {
      stop();
    }
  });
});

/**
 * The prod-state tick's failure paths (mt#3684).
 *
 * Driven through the extracted decision with its IO injected — the sweeper
 * reaches `./shared-persistence` and `./prod-state-cache` through dynamic
 * imports, so patching them in place would be the only alternative, and
 * ADR-036 bans it.
 */
describe("runProdStateRefreshTick failure paths (mt#3684)", () => {
  /** The driver error the 2026-08-07 outage produced on every connect attempt. */
  const CONNECT_TIMEOUT_MESSAGE = "write CONNECT_TIMEOUT db.example.com:6543";

  const neverCalled = async (): Promise<boolean> => {
    throw new Error("refresh should not have been reached");
  };

  test("(a) resolving the persistence service throwing reports a failure (AT4)", async () => {
    const result = await runProdStateRefreshTick({
      resolveRawSql: async () => {
        throw new Error(CONNECT_TIMEOUT_MESSAGE);
      },
      refresh: neverCalled,
    });
    expect(result).toEqual({ ok: false });
  });

  test("(b) the raw-SQL accessor throwing reports a failure (AT4)", async () => {
    const result = await runProdStateRefreshTick({
      resolveRawSql: async () => async () => {
        throw new Error("getaddrinfo ENOTFOUND aws-0-us-west-2.pooler.supabase.com");
      },
      refresh: neverCalled,
    });
    expect(result).toEqual({ ok: false });
  });

  test("(c) a provider exposing no raw SQL reports a failure instead of returning silently (AT4)", async () => {
    // The path that previously produced NO log, NO counter, and no trace at all.
    const result = await runProdStateRefreshTick({
      resolveRawSql: async () => null,
      refresh: neverCalled,
    });
    expect(result).toEqual({ ok: false });
  });

  test("a refresh that writes nothing is a failure, not a success (AT4)", async () => {
    const result = await runProdStateRefreshTick({
      resolveRawSql: async () => async () => ({ sql: true }),
      refresh: async () => false,
      now: () => "2026-08-09T00:00:00.000Z",
    });
    expect(result).toEqual({ ok: false });
  });

  test("a refresh that writes reports success, with the injected clock (AT6)", async () => {
    const seenIso: string[] = [];
    const result = await runProdStateRefreshTick({
      resolveRawSql: async () => async () => ({ sql: true }),
      refresh: async (_sql, nowIso) => {
        seenIso.push(nowIso);
        return true;
      },
      now: () => "2026-08-09T00:00:00.000Z",
    });
    expect(result).toEqual({ ok: true });
    expect(seenIso).toEqual(["2026-08-09T00:00:00.000Z"]);
  });

  /**
   * The second surface (AT5). `/api/sweeps` learning about the failure is only
   * half the fix — `/api/health.prodStateSweep` reads a DIFFERENT instrument,
   * and on 2026-08-06 both were simultaneously reassuring. These pin that an
   * upstream failure now reaches the domain tracker too, so the two surfaces
   * cannot disagree about whether the sweep is working.
   */
  function countingTracker() {
    const calls = { runs: 0, failures: 0 };
    return {
      calls,
      recordRun: () => {
        calls.runs++;
      },
      recordFailure: () => {
        calls.failures++;
      },
    };
  }

  test("an upstream failure reaches the domain tracker, not just the sweep registry (AT5)", async () => {
    for (const resolveRawSql of [
      async () => {
        throw new Error(CONNECT_TIMEOUT_MESSAGE);
      },
      async () => null,
    ] as Array<() => Promise<(() => Promise<unknown>) | null>>) {
      const tracker = countingTracker();
      const result = await runProdStateRefreshTick({
        resolveRawSql,
        refresh: neverCalled,
        tracker,
      });

      expect(result).toEqual({ ok: false });
      expect(tracker.calls.runs).toBe(1);
      expect(tracker.calls.failures).toBe(1);
    }
  });

  test("the no-raw-SQL path emits a warning where it previously emitted nothing (AT4c, PR #2746 R1)", async () => {
    // Fact-of-emission via an injected sink, not a patched logger (ADR-036).
    // This log IS the behavior: before mt#3684 the path returned silently, so a
    // provider that could never refresh the cache left no trace at all.
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const result = await runProdStateRefreshTick({
      resolveRawSql: async () => null,
      refresh: neverCalled,
      tracker: countingTracker(),
      logWarn: (message, meta) => warnings.push({ message, meta }),
    });

    expect(result).toEqual({ ok: false });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("no raw SQL connection");
  });

  test("a thrown upstream failure carries its cause into the warning (AT4a)", async () => {
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const result = await runProdStateRefreshTick({
      resolveRawSql: async () => {
        throw new Error(CONNECT_TIMEOUT_MESSAGE);
      },
      refresh: neverCalled,
      tracker: countingTracker(),
      logWarn: (message, meta) => warnings.push({ message, meta }),
    });

    expect(result).toEqual({ ok: false });
    expect(warnings).toHaveLength(1);
    // The driver's message is what distinguishes a blocked port from dead DNS
    // in the log, which is the only place that detail survives.
    expect(warnings[0]?.meta?.message).toContain("CONNECT_TIMEOUT");
  });

  test("the happy path emits no warning", async () => {
    const warnings: string[] = [];
    const result = await runProdStateRefreshTick({
      resolveRawSql: async () => async () => ({ sql: true }),
      refresh: async () => true,
      tracker: countingTracker(),
      logWarn: (message) => warnings.push(message),
    });

    expect(result).toEqual({ ok: true });
    expect(warnings).toEqual([]);
  });

  test("the refresh path does not double-record — refreshProdStateCache owns it (AT5)", async () => {
    // The two paths are mutually exclusive by construction; this asserts it,
    // because a double-count would inflate runsCount and make the surface wrong
    // in the opposite direction.
    const tracker = countingTracker();
    const result = await runProdStateRefreshTick({
      resolveRawSql: async () => async () => ({ sql: true }),
      refresh: async () => true,
      tracker,
    });

    expect(result).toEqual({ ok: true });
    expect(tracker.calls.runs).toBe(0);
    expect(tracker.calls.failures).toBe(0);
  });
});

/**
 * The ask-state tick (mt#3744) — the producer half of the calibration-review
 * cadence detector's disposition lookup.
 *
 * Same injected-IO shape as the prod-state tick above and for the same reason:
 * the sweeper reaches `./shared-persistence` and `./ask-state-cache` through
 * dynamic imports, and ADR-036 bans patching them in place.
 */
describe("runAskStateRefreshTick (mt#3744)", () => {
  const ASK_ID = "483dbcb0-788a-4159-9d8a-ba718ba1f2b0";
  const REPO_ROOT = "/mock/repo";
  const TICK_ISO = "2026-08-11T12:00:00.000Z";

  const neverCalled = async (): Promise<boolean> => {
    throw new Error("refresh should not have been reached");
  };

  test("a sweep run passes the watermark's ask ids and the stamped clock to the refresh", async () => {
    // AT "Unit (producer)": the tick asks about exactly the ids the watermark store names,
    // and stamps the record with the injected time.
    const seen: Array<{ askIds: string[]; nowIso: string }> = [];
    const result = await runAskStateRefreshTick({
      resolveRepoRoot: () => REPO_ROOT,
      readAskIds: (root) => (root === REPO_ROOT ? [ASK_ID] : []),
      resolveRawSql: async () => async () => ({ sql: true }),
      refresh: async (_sql, askIds, nowIso) => {
        seen.push({ askIds, nowIso });
        return true;
      },
      now: () => TICK_ISO,
    });

    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([{ askIds: [ASK_ID], nowIso: TICK_ISO }]);
  });

  test("no pending asks still refreshes — an empty snapshot is a successful sweep", async () => {
    // Load-bearing: skipping the write here would leave the previous snapshot to age into
    // "stale" even though the producer is healthy, and would make a covered-but-empty
    // snapshot indistinguishable from a producer that has never run.
    const seen: string[][] = [];
    const result = await runAskStateRefreshTick({
      resolveRepoRoot: () => REPO_ROOT,
      readAskIds: () => [],
      resolveRawSql: async () => async () => ({ sql: true }),
      refresh: async (_sql, askIds) => {
        seen.push(askIds);
        return true;
      },
      now: () => TICK_ISO,
    });

    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([[]]);
  });

  test("a provider exposing no raw SQL reports a failure and warns", async () => {
    const warnings: string[] = [];
    const result = await runAskStateRefreshTick({
      resolveRepoRoot: () => REPO_ROOT,
      readAskIds: () => [ASK_ID],
      resolveRawSql: async () => null,
      refresh: neverCalled,
      logWarn: (message) => warnings.push(message),
    });

    expect(result).toEqual({ ok: false });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no raw SQL connection");
  });

  test("resolving the connection throwing reports a failure carrying the driver message", async () => {
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const result = await runAskStateRefreshTick({
      resolveRepoRoot: () => REPO_ROOT,
      readAskIds: () => [ASK_ID],
      resolveRawSql: async () => {
        throw new Error("write CONNECT_TIMEOUT db.example.com:6543");
      },
      refresh: neverCalled,
      logWarn: (message, meta) => warnings.push({ message, meta }),
    });

    expect(result).toEqual({ ok: false });
    expect(warnings[0]?.meta?.message).toContain("CONNECT_TIMEOUT");
  });

  test("a refresh that writes nothing is a failure, not a success", async () => {
    const result = await runAskStateRefreshTick({
      resolveRepoRoot: () => REPO_ROOT,
      readAskIds: () => [ASK_ID],
      resolveRawSql: async () => async () => ({ sql: true }),
      refresh: async () => false,
      now: () => TICK_ISO,
    });
    expect(result).toEqual({ ok: false });
  });

  test("an unreadable watermark store is a failure, not a silent empty sweep", async () => {
    // If reading the ids throws, the tick must not go on to write an empty snapshot — that
    // would report every pending ask as `not-in-snapshot` while looking perfectly healthy.
    const warnings: string[] = [];
    const result = await runAskStateRefreshTick({
      resolveRepoRoot: () => REPO_ROOT,
      readAskIds: () => {
        throw new Error("EACCES: permission denied");
      },
      resolveRawSql: async () => async () => ({ sql: true }),
      refresh: neverCalled,
      logWarn: (message) => warnings.push(message),
    });

    expect(result).toEqual({ ok: false });
    expect(warnings).toHaveLength(1);
  });

  test("the happy path emits no warning", async () => {
    const warnings: string[] = [];
    const result = await runAskStateRefreshTick({
      resolveRepoRoot: () => REPO_ROOT,
      readAskIds: () => [ASK_ID],
      resolveRawSql: async () => async () => ({ sql: true }),
      refresh: async () => true,
      now: () => TICK_ISO,
      logWarn: (message) => warnings.push(message),
    });

    expect(result).toEqual({ ok: true });
    expect(warnings).toEqual([]);
  });
});

describe("self-scheduling registrants (mt#4185)", () => {
  afterEach(() => {
    _resetSweepLivenessRegistryForTest();
  });

  test("AT1: a registrant that stops reporting progress is flagged stalled and restarted", async () => {
    let restarts = 0;
    // Budget 15ms -> the meta-watchdog's stall threshold is 2x = 30ms, and it
    // scans every 20ms. Same shape as the dropped-timer test above.
    const handle = registerSelfSchedulingSweep({
      name: "test-self-scheduling-stall",
      progressBudgetMs: 15,
      restart: () => {
        restarts++;
      },
    });
    const stopWatchdog = startSweepMetaWatchdog(20);
    try {
      handle.noteProgress();

      const first = getSweepLivenessSnapshot().find((e) => e.name === "test-self-scheduling-stall");
      expect(first?.selfScheduled).toBe(true);
      expect(first?.intervalMs).toBe(15);
      expect(first?.lastAttemptAt).not.toBeNull();

      // Report nothing further: `lastAttemptAt` stops advancing, which is the
      // only signal the wedged poller gave off during the 44-hour incident.
      await waitFor(() => restarts >= 1, 2000);

      const after = getSweepLivenessSnapshot().find((e) => e.name === "test-self-scheduling-stall");
      expect(after?.metaRestarts).toBeGreaterThanOrEqual(1);
    } finally {
      stopWatchdog();
      handle.stop();
    }
  });

  test("AT3: a registrant reporting progress inside its budget is never restarted", async () => {
    let restarts = 0;
    const handle = registerSelfSchedulingSweep({
      name: "test-self-scheduling-healthy",
      progressBudgetMs: 200,
      restart: () => {
        restarts++;
      },
    });
    const stopWatchdog = startSweepMetaWatchdog(10);
    // Report every 15ms against a 200ms budget (400ms threshold) — the ratio a
    // healthy poller runs at, where a 25s long poll sits inside a 420s budget.
    //
    // Headroom widened from 60ms at PR #3065 R1: a NO-restart assertion whose
    // margin is a small multiple of the reporting interval can fail on
    // event-loop jitter rather than on the behaviour under test. Same class the
    // reviewer flagged in that PR's AT2; fixed here too rather than only there.
    const reporting = setInterval(() => handle.noteProgress(), 15);
    try {
      handle.noteProgress();
      await new Promise((r) => setTimeout(r, 250));
      expect(restarts).toBe(0);
      const entry = getSweepLivenessSnapshot().find(
        (e) => e.name === "test-self-scheduling-healthy"
      );
      expect(entry?.metaRestarts).toBe(0);
    } finally {
      clearInterval(reporting);
      stopWatchdog();
      handle.stop();
    }
  });

  test("a restart resets staleness itself, so one stall cannot become a restart storm", async () => {
    // mt#3060's lesson applied to this seam: a restart that does not stamp
    // progress is re-triggered on every subsequent scan, because nothing the
    // watchdog reads has changed. Assert the counter stays near 1 while the
    // participant reports nothing at all.
    let restarts = 0;
    const handle = registerSelfSchedulingSweep({
      name: "test-self-scheduling-no-storm",
      progressBudgetMs: 40,
      restart: () => {
        restarts++;
      },
    });
    const stopWatchdog = startSweepMetaWatchdog(5);
    try {
      handle.noteProgress();
      await waitFor(() => restarts >= 1, 2000);
      const afterFirst = restarts;
      // 100ms at a 5ms scan cadence is ~20 scans. Without the stamp inside
      // `restart`, every one of them would fire again.
      await new Promise((r) => setTimeout(r, 100));
      expect(restarts - afterFirst).toBeLessThanOrEqual(2);
    } finally {
      stopWatchdog();
      handle.stop();
    }
  });

  test("a failed cycle still counts as progress — erroring-but-alive is not wedged", () => {
    const handle = registerSelfSchedulingSweep({
      name: "test-self-scheduling-failure",
      progressBudgetMs: 1000,
      restart: () => {},
    });
    try {
      handle.noteFailure("telegram 502");
      const entry = getSweepLivenessSnapshot().find(
        (e) => e.name === "test-self-scheduling-failure"
      );
      expect(entry?.consecutiveFailures).toBe(1);
      expect(entry?.lastErrorAt).not.toBeNull();
      // The distinction the meta-watchdog exists to draw: a loop that is
      // failing is still cycling, so it must not be force-restarted.
      expect(entry?.lastAttemptAt).not.toBeNull();
    } finally {
      handle.stop();
    }
  });

  test("stop() removes the registrant from the public snapshot", () => {
    const handle = registerSelfSchedulingSweep({
      name: "test-self-scheduling-stop",
      progressBudgetMs: 1000,
      restart: () => {},
    });
    handle.noteProgress();
    expect(getSweepLivenessSnapshot().some((e) => e.name === "test-self-scheduling-stop")).toBe(
      true
    );
    handle.stop();
    expect(getSweepLivenessSnapshot().some((e) => e.name === "test-self-scheduling-stop")).toBe(
      false
    );
  });

  test("a duplicate ACTIVE registration throws rather than silently untracking the first", () => {
    const handle = registerSelfSchedulingSweep({
      name: "test-self-scheduling-dupe",
      progressBudgetMs: 1000,
      restart: () => {},
    });
    try {
      expect(() =>
        registerSelfSchedulingSweep({
          name: "test-self-scheduling-dupe",
          progressBudgetMs: 1000,
          restart: () => {},
        })
      ).toThrow(/duplicate active sweep registration/);
    } finally {
      handle.stop();
    }
  });

  test("AT1: a registrant that reports NOTHING is flagged stalled, measured from registration", async () => {
    // The first-cycle park (mt#4206): `noteProgress()` is never called, so
    // `lastAttemptAtMs` stays null. Before this fix the meta-watchdog skipped
    // the entry outright and it was permanently unevaluated.
    let restarts = 0;
    const handle = registerSelfSchedulingSweep({
      name: "test-never-reported",
      progressBudgetMs: 15,
      restart: () => {
        restarts++;
      },
    });
    const stopWatchdog = startSweepMetaWatchdog(20);
    try {
      await waitFor(() => restarts >= 1, 2000);
      expect(restarts).toBeGreaterThanOrEqual(1);
    } finally {
      stopWatchdog();
      handle.stop();
    }
  });

  test("AT2: an interval sweep registered alongside is untouched while the self-scheduled one is restarted", async () => {
    // The differential that makes AT1 safe: the SAME watchdog scan, in the same
    // window, must restart the self-scheduling never-reporter and leave the
    // interval sweep alone.
    //
    // Timing headroom is deliberate and load-bearing (PR #3065 R1). An earlier
    // version gave the interval sweep a 15ms cadence — a 30ms stall threshold
    // against a 20ms scan — which ordinary event-loop jitter can exceed, so the
    // assertion could fail for reasons unrelated to the branch under test. At
    // 1000ms the threshold is 2000ms and this test finishes in well under a
    // second, so no amount of jitter can flip it.
    //
    // On what this does NOT cover, stated rather than implied: an interval
    // sweep's `lastAttemptAtMs === null` window is not deterministically
    // reachable from a test, because `createIntervalSweeper` registers the entry
    // and schedules its boot tick in the same synchronous block — the stamp
    // lands a microtask later. That unreachability is itself why skipping the
    // null is safe on that path, and it is why this test asserts the observable
    // differential rather than staging a null it cannot hold open.
    let selfRestarts = 0;

    const stopInterval = createIntervalSweeper({
      name: "test-interval-not-flagged",
      intervalMs: 1_000,
      tickTimeoutMs: 5_000,
      tick: async () => {},
    });
    const selfHandle = registerSelfSchedulingSweep({
      name: "test-self-never-reports",
      progressBudgetMs: 15,
      restart: () => {
        selfRestarts++;
      },
    });
    const stopWatchdog = startSweepMetaWatchdog(20);
    try {
      await waitFor(() => selfRestarts >= 1, 2000);

      const intervalEntry = getSweepLivenessSnapshot().find(
        (e) => e.name === "test-interval-not-flagged"
      );
      expect(selfRestarts).toBeGreaterThanOrEqual(1);
      // Its boot tick stamped, so it is evaluated on the normal path and is
      // comfortably inside its own threshold.
      expect(intervalEntry?.lastAttemptAt).not.toBeNull();
      expect(intervalEntry?.metaRestarts).toBe(0);
    } finally {
      stopWatchdog();
      selfHandle.stop();
      stopInterval();
    }
  });

  test("AT3: the snapshot distinguishes never-reported from stale-reported", () => {
    const handle = registerSelfSchedulingSweep({
      name: "test-registered-at",
      progressBudgetMs: 60_000,
      restart: () => {},
    });
    try {
      const before = getSweepLivenessSnapshot().find((e) => e.name === "test-registered-at");
      // Never reported: a DATEABLE registration plus a null progress stamp —
      // not a bare null a reader has to interpret.
      expect(before?.registeredAt).toBeTruthy();
      expect(Number.isNaN(Date.parse(before?.registeredAt ?? ""))).toBe(false);
      expect(before?.lastAttemptAt).toBeNull();

      handle.noteProgress();
      const after = getSweepLivenessSnapshot().find((e) => e.name === "test-registered-at");
      // Reported: both fields present, so the two states are distinguishable
      // without inferring anything from a null.
      expect(after?.lastAttemptAt).not.toBeNull();
      expect(after?.registeredAt).toBe(before?.registeredAt as string);
    } finally {
      handle.stop();
    }
  });

  test("an interval sweep is reported as NOT self-scheduled, so intervalMs still reads as a cadence", async () => {
    const stop = createIntervalSweeper({
      name: "test-self-scheduling-discriminator",
      intervalMs: 60_000,
      tickTimeoutMs: 5_000,
      tick: async () => {},
    });
    try {
      await waitFor(() =>
        getSweepLivenessSnapshot().some((e) => e.name === "test-self-scheduling-discriminator")
      );
      const entry = getSweepLivenessSnapshot().find(
        (e) => e.name === "test-self-scheduling-discriminator"
      );
      expect(entry?.selfScheduled).toBe(false);
    } finally {
      stop();
    }
  });
});

describe("domain-failure backoff (mt#4294)", () => {
  afterEach(() => {
    _resetSweepLivenessRegistryForTest();
  });

  test("a persistently failing tick runs FEWER times than an identical one without backoff", async () => {
    // Controlled comparison rather than an absolute count: both sweepers fail
    // every tick at the same cadence in the same window, so the only
    // difference is the backoff. Asserting an exact tick count against
    // wall-clock would be flaky on a loaded machine; a relative comparison is
    // not.
    let withBackoff = 0;
    let withoutBackoff = 0;

    const stopA = createIntervalSweeper({
      name: "test-backoff-on",
      intervalMs: 20,
      tickTimeoutMs: 5_000,
      domainFailureBackoff: { afterFailures: 2, maxSkippedTicks: 4 },
      tick: async () => {
        withBackoff++;
        return { ok: false };
      },
    });
    const stopB = createIntervalSweeper({
      name: "test-backoff-off",
      intervalMs: 20,
      tickTimeoutMs: 5_000,
      tick: async () => {
        withoutBackoff++;
        return { ok: false };
      },
    });

    try {
      await waitFor(() => withoutBackoff >= 12, 3000);
      expect(withBackoff).toBeLessThan(withoutBackoff);
      // ...and it must still be PROBING. A backoff that stops entirely never
      // discovers the dependency recovered, which is the failure mode the
      // maxSkippedTicks clamp exists to prevent.
      expect(withBackoff).toBeGreaterThanOrEqual(2);
    } finally {
      stopA();
      stopB();
    }
  });

  test("does not skip anything while ticks keep succeeding", async () => {
    // The negative control for the test above: same option, same cadence,
    // only the outcome differs. If this one also skipped, the comparison above
    // would prove nothing about failure being the trigger.
    let calls = 0;
    const stop = createIntervalSweeper({
      name: "test-backoff-healthy",
      intervalMs: 20,
      tickTimeoutMs: 5_000,
      domainFailureBackoff: { afterFailures: 2, maxSkippedTicks: 4 },
      tick: async () => {
        calls++;
        return { ok: true };
      },
    });
    try {
      await waitFor(() => calls >= 10, 3000);
      expect(calls).toBeGreaterThanOrEqual(10);
    } finally {
      stop();
    }
  });

  test("a recovery clears the backoff, so the next tick is not skipped", async () => {
    let calls = 0;
    let failUntilCall = 4;
    const callsAtRecovery: number[] = [];

    const stop = createIntervalSweeper({
      name: "test-backoff-recovers",
      intervalMs: 20,
      tickTimeoutMs: 5_000,
      domainFailureBackoff: { afterFailures: 2, maxSkippedTicks: 4 },
      tick: async () => {
        calls++;
        if (calls <= failUntilCall) return { ok: false };
        callsAtRecovery.push(calls);
        return { ok: true };
      },
    });

    try {
      // Once healthy again, ticks should resume at full cadence — several
      // successes should land quickly rather than trickling in behind an
      // outstanding skip budget.
      await waitFor(() => callsAtRecovery.length >= 5, 3000);
      expect(callsAtRecovery.length).toBeGreaterThanOrEqual(5);
    } finally {
      failUntilCall = 0;
      stop();
    }
  });
});

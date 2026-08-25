/**
 * getSharedPersistenceService init-timeout + reset-on-hang tests (mt#2244).
 *
 * Verifies the "zombie singleton" wedge fix: when PersistenceService.initialize()
 * hangs, the cached init promise is cleared so the next caller retries with a
 * fresh attempt instead of joining a promise that never settles.
 *
 * Uses the createService factory seam (no mock.module — that persists across
 * bun:test files and would poison other suites). __resetSharedPersistenceForTests
 * clears the module-level singleton between tests.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { PersistenceService } from "@minsky/domain/persistence/service";
import {
  getSharedPersistenceService,
  PersistenceInitTimeoutError,
  DEFAULT_PERSISTENCE_INIT_TIMEOUT_MS,
  resolveDefaultInitTimeoutMs,
  __resetSharedPersistenceForTests,
  getDbStatus,
  markDbDegraded,
  startDbRetryBackoff,
  DEFAULT_DB_RETRY_INTERVAL_MS,
  refreshDbReachability,
  getDbCheck,
  DB_REACHABILITY_PROBE_TIMEOUT_MS,
  getPersistenceEpoch,
  recycleSharedPersistence,
  getDbRecycle,
  getDbHealth,
  shouldRecycleNow,
  __setRecycleThresholdsForTests,
  RECYCLE_AFTER_DEGRADED_MS,
  RECYCLE_CLOSE_TIMEOUT_MS,
  RECYCLE_MIN_INTERVAL_MS,
  type PersistenceServiceFactory,
} from "./shared-persistence";
// mt#4515: the inner drain budget, asserted against the outer deadline above.
import { CLOSE_TIMEOUT_SECONDS } from "@minsky/domain/persistence/providers/postgres-provider";

const ENV_KEY = "MINSKY_COCKPIT_PERSISTENCE_INIT_TIMEOUT_MS";

/**
 * postgres-js's code for an established connection that went away — the pool
 * wedge shape. Shared between the mt#3563 degraded-path tests (which use it as
 * an error MESSAGE) and the mt#3826 backoff tests (which use it as an error
 * CODE), so the two cannot drift apart.
 */
const CONNECTION_CLOSED = "CONNECTION_CLOSED";

/** Minimal stub satisfying the parts of PersistenceService this path touches. */
function makeService(initialize: () => Promise<void>): PersistenceService {
  return { initialize } as unknown as PersistenceService;
}

/** A promise that never resolves nor rejects — simulates a hung initialize(). */
function hangForever(): Promise<void> {
  return new Promise<void>(() => {});
}

beforeEach(() => __resetSharedPersistenceForTests());
afterEach(() => __resetSharedPersistenceForTests());

describe("getSharedPersistenceService init-timeout (mt#2244)", () => {
  test("hanging initialize() times out; the next caller retries with a fresh attempt", async () => {
    let initAttempts = 0;
    const factory: PersistenceServiceFactory = async () => {
      initAttempts += 1;
      const attempt = initAttempts;
      // First attempt hangs forever; subsequent attempts succeed.
      return makeService(() => (attempt === 1 ? hangForever() : Promise.resolve()));
    };

    // (a) First caller throws PersistenceInitTimeoutError after the deadline.
    await expect(getSharedPersistenceService(50, factory)).rejects.toBeInstanceOf(
      PersistenceInitTimeoutError
    );

    // (b) Second caller does NOT join the hung promise — the cached promise was
    //     cleared on timeout, so it gets a fresh init attempt and succeeds.
    const svc = await getSharedPersistenceService(50, factory);
    expect(svc).toBeDefined();
    expect(initAttempts).toBe(2);
  });

  test("successful initialize() within the deadline caches the instance (no re-init)", async () => {
    let initAttempts = 0;
    const factory: PersistenceServiceFactory = async () => {
      initAttempts += 1;
      return makeService(() => Promise.resolve());
    };

    const first = await getSharedPersistenceService(1000, factory);
    const second = await getSharedPersistenceService(1000, factory);
    expect(first).toBe(second);
    expect(initAttempts).toBe(1);
  });

  test("PersistenceInitTimeoutError reports elapsed milliseconds", async () => {
    const factory: PersistenceServiceFactory = async () => makeService(hangForever);

    let caught: unknown;
    try {
      await getSharedPersistenceService(30, factory);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PersistenceInitTimeoutError);
    expect((caught as PersistenceInitTimeoutError).elapsedMs).toBeGreaterThanOrEqual(20);
  });

  test("a hang in createService() (not just initialize()) trips the timeout", async () => {
    // The factory itself never resolves — the deadline must still fire because
    // the whole init sequence is inside the race (PR #1491 R1).
    const factory: PersistenceServiceFactory = () => new Promise(() => {});
    await expect(getSharedPersistenceService(40, factory)).rejects.toBeInstanceOf(
      PersistenceInitTimeoutError
    );
  });
});

describe("resolveDefaultInitTimeoutMs env override (mt#2244)", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env[ENV_KEY];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  test("falls back to the default when unset", () => {
    delete process.env[ENV_KEY];
    expect(resolveDefaultInitTimeoutMs()).toBe(DEFAULT_PERSISTENCE_INIT_TIMEOUT_MS);
  });

  test("uses a valid positive integer override", () => {
    process.env[ENV_KEY] = "5000";
    expect(resolveDefaultInitTimeoutMs()).toBe(5000);
  });

  test("falls back to the default on non-numeric, zero, or negative values", () => {
    for (const bad of ["abc", "0", "-1", ""]) {
      process.env[ENV_KEY] = bad;
      expect(resolveDefaultInitTimeoutMs()).toBe(DEFAULT_PERSISTENCE_INIT_TIMEOUT_MS);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// gh#1761: DB status + graceful-degradation tests
// ────────────────────────────────────────────────────────────────────────────

describe("getDbStatus (gh#1761)", () => {
  test("initial status is 'unreachable' (no init attempt yet)", () => {
    expect(getDbStatus()).toBe("unreachable");
  });

  test("status becomes 'ok' after a successful init", async () => {
    const factory: PersistenceServiceFactory = async () => makeService(() => Promise.resolve());

    await getSharedPersistenceService(500, factory);
    expect(getDbStatus()).toBe("ok");
  });

  test("status becomes 'degraded' after a failed init", async () => {
    const factory: PersistenceServiceFactory = async () =>
      makeService(() => Promise.reject(new Error("auth failure")));

    await expect(getSharedPersistenceService(500, factory)).rejects.toThrow();
    expect(getDbStatus()).toBe("degraded");
  });

  test("status becomes 'degraded' after an init timeout", async () => {
    const factory: PersistenceServiceFactory = async () => makeService(hangForever);

    await expect(getSharedPersistenceService(30, factory)).rejects.toBeInstanceOf(
      PersistenceInitTimeoutError
    );
    expect(getDbStatus()).toBe("degraded");
  });
});

describe("markDbDegraded (gh#1761)", () => {
  test("sets status to 'degraded' and resets the singleton", async () => {
    // First succeed so status is 'ok'.
    const factory: PersistenceServiceFactory = async () => makeService(() => Promise.resolve());
    await getSharedPersistenceService(500, factory);
    expect(getDbStatus()).toBe("ok");

    // Now degrade.
    markDbDegraded();
    expect(getDbStatus()).toBe("degraded");

    // The singleton is cleared — the next caller gets a fresh init.
    let initCalls = 0;
    const factory2: PersistenceServiceFactory = async () => {
      initCalls += 1;
      return makeService(() => Promise.resolve());
    };
    await getSharedPersistenceService(500, factory2);
    expect(initCalls).toBe(1);
    expect(getDbStatus()).toBe("ok");
  });
});

describe("startDbRetryBackoff (gh#1761)", () => {
  test("exported constant DEFAULT_DB_RETRY_INTERVAL_MS is 30_000", () => {
    expect(DEFAULT_DB_RETRY_INTERVAL_MS).toBe(30_000);
  });

  test("retries after failure and eventually succeeds, setting status to ok", async () => {
    let initAttempts = 0;
    const factory: PersistenceServiceFactory = async () => {
      initAttempts += 1;
      // Fail on first two attempts, succeed on third.
      if (initAttempts <= 2) {
        return makeService(() => Promise.reject(new Error("circuit open")));
      }
      return makeService(() => Promise.resolve());
    };

    // Prime: first caller fails and sets status to degraded.
    await expect(getSharedPersistenceService(500, factory)).rejects.toThrow();
    expect(getDbStatus()).toBe("degraded");

    // Start retry backoff with a very short interval so the test finishes fast.
    const stop = startDbRetryBackoff(10, factory);

    // Poll until status is ok (up to ~2s: 20ms × 100 iterations).
    for (let i = 0; i < 100 && getDbStatus() !== "ok"; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }

    stop();

    expect(getDbStatus()).toBe("ok");
    // At least 3 init calls: 1 from getSharedPersistenceService + 2 failures + 1 success from retry.
    expect(initAttempts).toBeGreaterThanOrEqual(3);
  });

  test("stop() prevents further retries", async () => {
    // Arrange: put status in degraded.
    const factory: PersistenceServiceFactory = async () =>
      makeService(() => Promise.reject(new Error("always down")));
    await expect(getSharedPersistenceService(500, factory)).rejects.toThrow();
    expect(getDbStatus()).toBe("degraded");

    let callsAfterStop = 0;
    let stopped = false;
    const factory2: PersistenceServiceFactory = async () => {
      if (stopped) callsAfterStop += 1;
      return makeService(() => Promise.reject(new Error("still down")));
    };

    const stop = startDbRetryBackoff(20, factory2);
    // Stop before the first retry fires.
    stopped = true;
    stop();

    // Wait one retry interval to confirm no calls happen after stop().
    await new Promise((r) => setTimeout(r, 50));
    expect(callsAfterStop).toBe(0);
  });

  test("does not start retry when status is already ok", async () => {
    // Ensure status is ok first.
    const factory: PersistenceServiceFactory = async () => makeService(() => Promise.resolve());
    await getSharedPersistenceService(500, factory);
    expect(getDbStatus()).toBe("ok");

    let initCalls = 0;
    const factory2: PersistenceServiceFactory = async () => {
      initCalls += 1;
      return makeService(() => Promise.resolve());
    };

    const stop = startDbRetryBackoff(10, factory2);
    await new Promise((r) => setTimeout(r, 50));
    stop();

    // No retry should have fired because status was already ok.
    expect(initCalls).toBe(0);
  });
  test("clears pending retry timer on success (gh#1761 R1)", async () => {
    // Arrange: prime the status to degraded.
    const alwaysFailFactory: PersistenceServiceFactory = async () =>
      makeService(() => Promise.reject(new Error("down")));
    await expect(getSharedPersistenceService(500, alwaysFailFactory)).rejects.toThrow();
    expect(getDbStatus()).toBe("degraded");

    // Factory succeeds on its first attempt (within the retry loop).
    let initCallsAfterSuccess = 0;
    let hasSucceeded = false;
    const onceSucceedFactory: PersistenceServiceFactory = async () => {
      if (!hasSucceeded) {
        hasSucceeded = true;
        return makeService(() => Promise.resolve());
      }
      // Any call after the first success is unexpected.
      initCallsAfterSuccess += 1;
      return makeService(() => Promise.resolve());
    };

    const stop = startDbRetryBackoff(10, onceSucceedFactory);

    // Wait for status to become ok.
    for (let i = 0; i < 100 && getDbStatus() !== "ok"; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(getDbStatus()).toBe("ok");

    // Wait an extra interval to confirm no further retry calls happen.
    await new Promise((r) => setTimeout(r, 50));
    stop();

    // The pending timer must have been cleared — no calls after the success.
    expect(initCallsAfterSuccess).toBe(0);
  });
});

describe("getSharedPersistenceService orphan teardown on timeout (mt#2248)", () => {
  /** Service stub backed by an externally-controlled init promise + close() counter. */
  function controllableService(
    initPromise: Promise<void>,
    onClose: () => void
  ): PersistenceService {
    return {
      initialize: () => initPromise,
      close: async () => onClose(),
    } as unknown as PersistenceService;
  }

  /** Flush pending microtasks + one macrotask turn so the teardown chain runs. */
  function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  // Deterministic (no wall-clock race): init never settles until we explicitly
  // resolve/reject it AFTER the timeout rejection has already been observed, so
  // the deadline always wins regardless of CI load. (PR #1542 R1.)
  test("a timed-out init that RESOLVES after the deadline closes the orphaned service", async () => {
    let closeCalls = 0;
    let resolveInit!: () => void;
    const initPromise = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });
    const factory: PersistenceServiceFactory = async () =>
      controllableService(initPromise, () => {
        closeCalls += 1;
      });

    await expect(getSharedPersistenceService(5, factory)).rejects.toBeInstanceOf(
      PersistenceInitTimeoutError
    );
    expect(closeCalls).toBe(0); // not closed yet — init still pending

    // Now let the orphaned init resolve; the teardown must close it.
    resolveInit();
    await flush();
    expect(closeCalls).toBe(1);
  });

  test("a timed-out init that REJECTS after the deadline does not call close()", async () => {
    let closeCalls = 0;
    let rejectInit!: (err: Error) => void;
    const initPromise = new Promise<void>((_resolve, reject) => {
      rejectInit = reject;
    });
    const factory: PersistenceServiceFactory = async () =>
      controllableService(initPromise, () => {
        closeCalls += 1;
      });

    await expect(getSharedPersistenceService(5, factory)).rejects.toBeInstanceOf(
      PersistenceInitTimeoutError
    );

    rejectInit(new Error("late init failure"));
    await flush();
    expect(closeCalls).toBe(0);
  });
});

describe("refreshDbReachability (mt#3563)", () => {
  beforeEach(() => {
    __resetSharedPersistenceForTests();
  });

  afterEach(() => {
    __resetSharedPersistenceForTests();
  });

  test("a query that completes reports ok, dated, with a latency", async () => {
    const status = await refreshDbReachability(async () => [{ reachable: 1 }], 1000);

    expect(status).toBe("ok");
    expect(getDbStatus()).toBe("ok");
    const check = getDbCheck();
    expect(typeof check.checkedAt).toBe("string");
    expect(typeof check.latencyMs).toBe("number");
  });

  test("a query that NEVER settles reports degraded instead of hanging", async () => {
    // The defect this task exists to report: no rejection is ever produced, so
    // nothing downstream can classify an error. Only a deadline catches it.
    const neverSettles = () => new Promise<never>(() => {});

    // _instance is set so the degraded/unreachable branch resolves to degraded.
    await getSharedPersistenceService(1000, async () => makeService(async () => {}));
    expect(getDbStatus()).toBe("ok");

    const status = await refreshDbReachability(neverSettles, 20);

    expect(status).toBe("degraded");
    expect(getDbStatus()).toBe("degraded");
  });

  test("does not issue a second probe while one is still outstanding", async () => {
    let issued = 0;
    const neverSettles = () => {
      issued++;
      return new Promise<never>(() => {});
    };

    await refreshDbReachability(neverSettles, 20);
    expect(issued).toBe(1);

    // Every subsequent poll must reuse the outstanding-probe signal rather than
    // issuing another query — each abandoned probe would hold a pool slot for
    // the life of the process, so an unbounded number would be self-inflicted
    // pool exhaustion by the very thing meant to detect it.
    await refreshDbReachability(neverSettles, 20);
    await refreshDbReachability(neverSettles, 20);

    expect(issued).toBe(1);
    expect(getDbStatus()).not.toBe("ok");
  });

  test("recovers to ok once the outstanding probe settles — no restart needed", async () => {
    let release: (() => void) | undefined;
    const blocked = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });

    await refreshDbReachability(blocked, 20);
    expect(getDbStatus()).not.toBe("ok");

    // The stuck query finally comes back; the slot must be released so the pool
    // becomes probeable again.
    release?.();
    await Promise.resolve();
    await Promise.resolve();

    const status = await refreshDbReachability(async () => [{ reachable: 1 }], 1000);
    expect(status).toBe("ok");
  });

  test("a rejecting probe is reported, not swallowed", async () => {
    await getSharedPersistenceService(1000, async () => makeService(async () => {}));

    const status = await refreshDbReachability(async () => {
      throw new Error("CONNECTION_CLOSED");
    }, 1000);

    expect(status).toBe("degraded");
    expect(getDbCheck().checkedAt).not.toBeNull();
  });

  test("the default deadline is a real bound, not disabled", () => {
    expect(DB_REACHABILITY_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DB_REACHABILITY_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

describe("refreshDbReachability review fixes (PR #2558 R1)", () => {
  beforeEach(() => {
    __resetSharedPersistenceForTests();
  });

  afterEach(() => {
    __resetSharedPersistenceForTests();
  });

  test("does NOT restamp checkedAt on a poll that only observes an outstanding probe", async () => {
    // First poll issues a probe that never returns; it hits the deadline, which
    // IS a finish, so it stamps checkedAt.
    await refreshDbReachability(() => new Promise<never>(() => {}), 20);
    const afterFirst = getDbCheck().checkedAt;
    expect(afterFirst).not.toBeNull();

    await new Promise((r) => setTimeout(r, 15));

    // Subsequent polls determine nothing new — they only observe that the same
    // probe is still out. Restamping here would advertise a fresh measurement
    // that never happened.
    await refreshDbReachability(() => new Promise<never>(() => {}), 20);
    expect(getDbCheck().checkedAt).toBe(afterFirst);
  });

  test("skips a probe inside the healthy-state floor", async () => {
    let issued = 0;
    const ok = async () => {
      issued++;
      return [{ reachable: 1 }];
    };

    await refreshDbReachability(ok, 1000, 10_000);
    expect(issued).toBe(1);
    expect(getDbStatus()).toBe("ok");

    // Healthy and inside the floor → no query issued.
    await refreshDbReachability(ok, 1000, 10_000);
    await refreshDbReachability(ok, 1000, 10_000);
    expect(issued).toBe(1);
  });

  test("the floor never applies while degraded, so recovery is seen on the next poll", async () => {
    await getSharedPersistenceService(1000, async () => makeService(async () => {}));

    // Reach degraded with the floor disabled, so this step is unambiguous.
    await refreshDbReachability(
      async () => {
        throw new Error(CONNECTION_CLOSED);
      },
      1000,
      0
    );
    expect(getDbStatus()).toBe("degraded");

    // A large floor must NOT suppress the next probe — if it did, a recovered
    // pool would keep reporting degraded for the floor's duration.
    let issued = 0;
    const status = await refreshDbReachability(
      async () => {
        issued++;
        return [{ reachable: 1 }];
      },
      1000,
      10_000
    );

    expect(issued).toBe(1);
    expect(status).toBe("ok");
  });
});

describe("recycle close outcome counters (mt#4549)", () => {
  beforeEach(() => {
    __resetSharedPersistenceForTests();
  });

  test("a fresh process reports zero recycles AND zero of every outcome", () => {
    const r = getDbRecycle();
    expect(r.recycleCount).toBe(0);
    expect(r.closesDrained).toBe(0);
    expect(r.closesForceTerminated).toBe(0);
    expect(r.closesAbandoned).toBe(0);

    // SC3, and the reason `closesAbandoned` must never be read on its own: this
    // reading and "12 recycles, none abandoned" are the same zero and completely
    // different claims. `recycleCount` is what separates them — a consumer that
    // alerts on `closesAbandoned > 0` alone would call an untested process
    // healthy (mem#704: a probe that reads the same in the healthy and broken
    // cases carries no information).
    expect(r.recycleCount).toBe(0);
  });

  test("a recycle whose close drains increments only the drained counter", async () => {
    let closeCalls = 0;
    const factory: PersistenceServiceFactory = async () =>
      ({
        initialize: async () => {},
        close: async () => {
          closeCalls++;
        },
        getProvider: () => ({}),
      }) as unknown as PersistenceService;

    await getSharedPersistenceService(1_000, factory);
    recycleSharedPersistence("test recycle");

    // close() is fire-and-forget; give its microtask a beat, as the mt#3638
    // tests in this file already do.
    await new Promise((r) => setTimeout(r, 20));

    const r = getDbRecycle();
    expect(closeCalls).toBe(1);
    expect(r.recycleCount).toBe(1);
    // Asserting WHICH counter moved, not that a total changed — a test that only
    // checked a sum would pass if the outcome were misclassified, and telling the
    // three apart is the entire point of these counters.
    expect(r.closesDrained).toBe(1);
    expect(r.closesForceTerminated).toBe(0);
    expect(r.closesAbandoned).toBe(0);
  });

  test("counters reset between tests, so a reading never depends on test order", () => {
    // Guards the mt#3575 hazard directly: these are module-level `let`s in a file
    // whose module state is already a known order-dependence cluster. If the reset
    // in __resetSharedPersistenceForTests is ever dropped, the preceding test's
    // increment leaks into this one and this fails.
    const r = getDbRecycle();
    expect(r.closesDrained).toBe(0);
    expect(r.recycleCount).toBe(0);
  });
});

describe("recycle close bounds (mt#4515)", () => {
  test("the inner drain budget fires strictly before the outer recycle deadline", () => {
    // These two live in different packages and neither can see the other's
    // value at runtime, so the invariant is asserted here — the one place both
    // are importable — rather than restated as a comment in each.
    //
    // Direction matters and is not symmetric. The INNER bound
    // (`CLOSE_TIMEOUT_SECONDS`, handed to postgres-js's `end({ timeout })`) is
    // what actually terminates sockets. The OUTER one only stops the recycle
    // path from awaiting forever. If the outer fires first, the recycle
    // abandons the close before the driver has terminated anything and the
    // connections leak — which is exactly the pre-mt#4515 behaviour, where the
    // inner bound did not exist at all and the outer one was therefore always
    // the winner: 88 abandoned closes, zero clean, across every retained log.
    expect(CLOSE_TIMEOUT_SECONDS * 1000).toBeLessThan(RECYCLE_CLOSE_TIMEOUT_MS);
  });

  test("the margin between them leaves room for the terminate round-trip", () => {
    // A bound that is merely lower is not enough — `destroy()` still has to
    // await `c.terminate()` on every connection after the timer fires. Assert a
    // real margin so a future tweak that makes them near-equal (which would
    // reintroduce the race non-deterministically, the worst version of this
    // bug) fails here instead of in production.
    const marginMs = RECYCLE_CLOSE_TIMEOUT_MS - CLOSE_TIMEOUT_SECONDS * 1000;
    expect(marginMs).toBeGreaterThanOrEqual(1000);
  });
});

describe("shouldRecycleNow (mt#3638)", () => {
  const base = {
    nowMs: 100_000,
    degradedSinceMs: 80_000,
    lastRecycleAtMs: null,
    hasService: true,
    afterDegradedMs: 15_000,
    minIntervalMs: 60_000,
  };

  test("exported thresholds carry their derivation", () => {
    // 3 probe deadlines of continuous degradation = the evidence 3 failed
    // probes would have been (the wedge's probe never COMPLETES, so a
    // completed-probe count cannot work — see the constant's doc).
    expect(RECYCLE_AFTER_DEGRADED_MS).toBe(3 * DB_REACHABILITY_PROBE_TIMEOUT_MS);
    expect(RECYCLE_MIN_INTERVAL_MS).toBe(60_000);
  });

  test("fires after sustained degradation with no prior recycle", () => {
    expect(shouldRecycleNow(base)).toBe(true);
  });

  test("does not fire while the degraded run is younger than the threshold", () => {
    expect(shouldRecycleNow({ ...base, degradedSinceMs: 90_000 })).toBe(false);
  });

  test("does not fire when nothing is degraded", () => {
    expect(shouldRecycleNow({ ...base, degradedSinceMs: null })).toBe(false);
  });

  test("rate limit: does not fire within minIntervalMs of the last recycle", () => {
    expect(shouldRecycleNow({ ...base, lastRecycleAtMs: 50_000 })).toBe(false);
  });

  test("fires again once the rate-limit window has passed", () => {
    expect(shouldRecycleNow({ ...base, lastRecycleAtMs: 30_000 })).toBe(true);
  });

  test("does not fire when there is no service to tear down", () => {
    expect(shouldRecycleNow({ ...base, hasService: false })).toBe(false);
  });
});

describe("recycleSharedPersistence (mt#3638)", () => {
  function makeCloseTrackingFactory(close: () => Promise<void>) {
    let factoryCalls = 0;
    const factory: PersistenceServiceFactory = async () => {
      factoryCalls++;
      return {
        initialize: async () => {},
        close,
        getProvider: () => ({}),
      } as unknown as PersistenceService;
    };
    return { factory, calls: () => factoryCalls };
  }

  test("resets the singleton, bumps the epoch, and closes the old service", async () => {
    let closeCalls = 0;
    const { factory, calls } = makeCloseTrackingFactory(async () => {
      closeCalls++;
    });
    const first = await getSharedPersistenceService(1_000, factory);
    expect(calls()).toBe(1);
    const epochBefore = getPersistenceEpoch();

    recycleSharedPersistence("test recycle");

    expect(getPersistenceEpoch()).toBe(epochBefore + 1);
    expect(getDbStatus()).toBe("degraded");
    const second = await getSharedPersistenceService(1_000, factory);
    expect(calls()).toBe(2);
    expect(second).not.toBe(first);
    // close() is fire-and-forget; give its microtask a beat to run.
    await new Promise((r) => setTimeout(r, 10));
    expect(closeCalls).toBe(1);
  });

  test("a close() that never settles does not delay the recycle or the next init", async () => {
    const { factory } = makeCloseTrackingFactory(() => new Promise<void>(() => {}));
    await getSharedPersistenceService(1_000, factory);

    const beforeMs = performance.now();
    recycleSharedPersistence("wedged close");
    // Synchronous state reset — no await on the hung close.
    expect(performance.now() - beforeMs).toBeLessThan(100);

    const fresh = await getSharedPersistenceService(1_000, factory);
    expect(fresh).toBeDefined();
    expect(getDbStatus()).toBe("ok");
  });

  test("updates recycle telemetry", async () => {
    const { factory } = makeCloseTrackingFactory(async () => {});
    await getSharedPersistenceService(1_000, factory);
    // Kept as a STRICT toEqual deliberately: it is what caught mt#4549 adding
    // fields, which is the job. A loosened matcher here would let the payload
    // grow silently, and this object is a documented /api/health contract.
    expect(getDbRecycle()).toEqual({
      lastRecycleAt: null,
      recycleCount: 0,
      closesDrained: 0,
      closesForceTerminated: 0,
      closesAbandoned: 0,
    });

    recycleSharedPersistence("telemetry test");

    const telemetry = getDbRecycle();
    expect(telemetry.recycleCount).toBe(1);
    expect(telemetry.lastRecycleAt).not.toBeNull();
  });

  test("markDbDegraded also bumps the epoch (cache-staleness parity)", async () => {
    const { factory } = makeCloseTrackingFactory(async () => {});
    await getSharedPersistenceService(1_000, factory);
    const epochBefore = getPersistenceEpoch();
    markDbDegraded();
    expect(getPersistenceEpoch()).toBe(epochBefore + 1);
  });
});

describe("refreshDbReachability recycle trigger (mt#3638)", () => {
  test("sustained degraded observations recycle the pool in place — including the never-settle wedge shape", async () => {
    __setRecycleThresholdsForTests(20, 0);
    let closeCalls = 0;
    let factoryCalls = 0;
    const factory: PersistenceServiceFactory = async () => {
      factoryCalls++;
      return {
        initialize: async () => {},
        close: async () => {
          closeCalls++;
        },
      } as unknown as PersistenceService;
    };
    await getSharedPersistenceService(1_000, factory);

    // The wedge: a probe that NEVER settles (mt#3092 / postgres#1089 shape).
    const hungProbe = () => new Promise<unknown>(() => {});

    // First call issues the probe; the 5ms deadline expires -> degraded run starts.
    await refreshDbReachability(hungProbe, 5);
    expect(getDbStatus()).toBe("degraded");
    expect(getDbRecycle().recycleCount).toBe(0);

    // Let the degraded run exceed the (shrunk) threshold, then poll again.
    // This poll takes the outstanding-probe branch — the probe never settled —
    // which is exactly the branch that had to count toward the trigger.
    await new Promise((r) => setTimeout(r, 30));
    await refreshDbReachability(hungProbe, 5);

    expect(getDbRecycle().recycleCount).toBe(1);
    // The next caller rebuilds a fresh service (the in-place recovery).
    await getSharedPersistenceService(1_000, factory);
    expect(factoryCalls).toBe(2);
    await new Promise((r) => setTimeout(r, 10));
    expect(closeCalls).toBe(1);
  });

  test("a recovering probe resets the degraded run (no recycle on transient blips)", async () => {
    __setRecycleThresholdsForTests(20, 0);
    const factory: PersistenceServiceFactory = async () =>
      ({
        initialize: async () => {},
        close: async () => {},
      }) as unknown as PersistenceService;
    await getSharedPersistenceService(1_000, factory);

    // One failing probe (rejects immediately -> degraded run starts)...
    await refreshDbReachability(() => Promise.reject(new Error("blip")), 5);
    expect(getDbStatus()).toBe("degraded");
    // ...then recovery before the threshold elapses.
    await refreshDbReachability(() => Promise.resolve("ok"), 5);
    expect(getDbStatus()).toBe("ok");

    // Degradation resumes but its clock started FRESH — older-than-threshold
    // history from the first blip must not count.
    await new Promise((r) => setTimeout(r, 30));
    await refreshDbReachability(() => Promise.reject(new Error("blip 2")), 5);
    expect(getDbRecycle().recycleCount).toBe(0);
  });
});

describe("recycle rate limit (mt#3638 AT4)", () => {
  test("repeated degraded observations inside the rate-limit window produce exactly ONE recycle", async () => {
    // Sustained-degradation threshold: 10ms; rate limit: 60s (far beyond test).
    __setRecycleThresholdsForTests(10, 60_000);
    const factory: PersistenceServiceFactory = async () =>
      ({
        initialize: async () => {},
        close: async () => {},
      }) as unknown as PersistenceService;
    await getSharedPersistenceService(1_000, factory);

    // Enter a degraded run and let it exceed the threshold.
    await refreshDbReachability(() => Promise.reject(new Error("down")), 5);
    await new Promise((r) => setTimeout(r, 15));

    // Several degraded observations, all past the duration threshold — only
    // the FIRST may recycle; the rest fall inside the rate-limit window.
    await refreshDbReachability(() => Promise.reject(new Error("down")), 5);
    await refreshDbReachability(() => Promise.reject(new Error("down")), 5);
    await refreshDbReachability(() => Promise.reject(new Error("down")), 5);

    expect(getDbRecycle().recycleCount).toBe(1);
  });
});

describe("failure classification on the health payload (mt#3826)", () => {
  /** An error shaped like postgres-js's `Errors.connection` output. */
  function driverError(code: string): Error {
    return Object.assign(new Error(`write ${code} db.example.com:6543`), {
      code,
      errno: code,
      address: "db.example.com",
      port: 6543,
    });
  }

  const okFactory: PersistenceServiceFactory = async () =>
    ({ initialize: async () => {}, close: async () => {} }) as unknown as PersistenceService;

  test("a blocked port surfaces as connect-timeout, not a bare degraded (AT1, AT4)", async () => {
    await getSharedPersistenceService(1_000, okFactory);
    await refreshDbReachability(() => Promise.reject(driverError("CONNECT_TIMEOUT")), 50);

    expect(getDbStatus()).toBe("degraded");
    const health = getDbHealth();
    // AT4: a consumer branches on a value, with no error-message parsing.
    expect(health.failure?.kind).toBe("connect-timeout");
    expect(health.failure?.code).toBe("CONNECT_TIMEOUT");
    expect(health.mode).toBe("unavailable");
    expect(health.reason).toContain("port");
  });

  test("refused is distinguished from connect-timeout on the payload (AT2)", async () => {
    await getSharedPersistenceService(1_000, okFactory);
    await refreshDbReachability(() => Promise.reject(driverError("ECONNREFUSED")), 50);
    expect(getDbHealth().failure?.kind).toBe("refused");

    __resetSharedPersistenceForTests();
    await getSharedPersistenceService(1_000, okFactory);
    await refreshDbReachability(() => Promise.reject(driverError("CONNECT_TIMEOUT")), 50);
    expect(getDbHealth().failure?.kind).toBe("connect-timeout");
  });

  test("does not forward the driver's raw message onto the payload (PR #2732 R1)", async () => {
    // The driver's message embeds `host:port`, and a server-side PostgresError
    // message is arbitrary server-controlled text. /api/health is polled by the
    // tray and three webview query keys, so it must not carry text this process
    // did not author. `kind` + `code` are what a consumer branches on.
    await getSharedPersistenceService(1_000, okFactory);
    await refreshDbReachability(() => Promise.reject(driverError("CONNECT_TIMEOUT")), 50);

    const failure = getDbHealth().failure;
    expect(failure).toEqual({ kind: "connect-timeout", code: "CONNECT_TIMEOUT" });
    expect(Object.keys(failure ?? {})).not.toContain("message");
    expect(JSON.stringify(getDbHealth())).not.toContain("db.example.com");
  });

  test("stamps lastAttemptAt so a stuck process is distinguishable from an outage", async () => {
    // ADR-035 rule 4. Absent means "nothing tried since boot", which is the
    // distinction an operator cannot otherwise make.
    expect(getDbHealth().lastAttemptAt).toBeUndefined();
    await getSharedPersistenceService(1_000, okFactory);
    expect(getDbHealth().lastAttemptAt).toBeDefined();
  });

  test("a code-less error does not overwrite a real classification", async () => {
    // Load-bearing, not defensive: the 5s probe deadline fires BEFORE
    // postgres-js's 10s connect_timeout, so a code-less deadline Error routinely
    // arrives after the driver's real code. Clobbering would discard the one
    // signal this task exists to capture.
    await getSharedPersistenceService(1_000, okFactory);
    await refreshDbReachability(() => Promise.reject(driverError("CONNECT_TIMEOUT")), 50);
    expect(getDbHealth().failure?.kind).toBe("connect-timeout");

    await refreshDbReachability(() => Promise.reject(new Error("no code")), 50);
    expect(getDbHealth().failure?.kind).toBe("connect-timeout");
  });

  test("recovery clears the classification and returns mode to connected (AT3)", async () => {
    await getSharedPersistenceService(1_000, okFactory);
    await refreshDbReachability(() => Promise.reject(driverError("CONNECT_TIMEOUT")), 50);
    expect(getDbHealth().failure?.kind).toBe("connect-timeout");

    await refreshDbReachability(() => Promise.resolve("ok"), 50);
    expect(getDbStatus()).toBe("ok");
    const health = getDbHealth();
    expect(health.mode).toBe("connected");
    expect(health.failure).toBeUndefined();
  });
});

describe("recycle backoff by failure kind (mt#3826 AT1/AT3)", () => {
  function driverError(code: string): Error {
    return Object.assign(new Error(`write ${code} db.example.com:6543`), { code, errno: code });
  }

  /** An init that never settles — the shape a blocked port presents. */
  const hangingFactory: PersistenceServiceFactory = async () =>
    ({
      initialize: () => new Promise<void>(() => {}),
      close: async () => {},
    }) as unknown as PersistenceService;

  /**
   * Drive `rounds` degraded observations of one failure kind and report how
   * many recycles the trigger allowed.
   *
   * Two structural choices, both load-bearing. **The init never settles**: a
   * SUCCEEDING re-init would count as recovery, resetting both the degraded run
   * and the futile-recycle counter, so the backoff could never accumulate — and
   * it would also misrepresent the scenario, since a blocked port does not
   * produce a working pool between recycles. **Each round re-primes**: a
   * recycle clears `_initPromise`, and `shouldRecycleNow` correctly refuses to
   * fire when there is nothing to tear down.
   *
   * The absolute cadence arithmetic is pinned by the pure `nextRecycleIntervalMs`
   * tests in `packages/domain/src/persistence/connection-failure.test.ts`, which
   * need no clock at all. What this checks is the WIRING — that the
   * classification actually reaches the trigger — so both kinds run identical
   * sleeps and the assertion is a CONTRAST between them. A timing wobble moves
   * both arms together and cannot manufacture a false difference, which is the
   * flakiness shape mem#883 warns about with elapsed-time assertions.
   */
  async function recyclesAfterRounds(code: string, rounds: number): Promise<number> {
    __resetSharedPersistenceForTests();
    // Degraded-duration threshold 10ms; base recycle floor 100ms.
    __setRecycleThresholdsForTests(10, 100);
    const fail = () => Promise.reject(driverError(code));
    for (let i = 0; i < rounds; i++) {
      void getSharedPersistenceService(60_000, hangingFactory).catch(() => {});
      await refreshDbReachability(fail, 20);
      await new Promise((r) => setTimeout(r, 150));
      await refreshDbReachability(fail, 20);
    }
    return getDbRecycle().recycleCount;
  }

  test("a connect-timeout streak backs off; a pool wedge keeps recycling", async () => {
    // The wedge kind is the negative control against over-correction (criterion
    // 4): `connection-lost` is exactly what `recycleSharedPersistence` was built
    // to fix (mt#3638), so backing IT off would make a recoverable outage last
    // longer. Same rounds, same sleeps, different kind.
    const ROUNDS = 10;
    const wedgeRecycles = await recyclesAfterRounds(CONNECTION_CLOSED, ROUNDS);
    const blockedRecycles = await recyclesAfterRounds("CONNECT_TIMEOUT", ROUNDS);

    expect(wedgeRecycles).toBe(ROUNDS);
    expect(blockedRecycles).toBeLessThan(wedgeRecycles);
  }, 30_000);
});

/**
 * Unaided recovery, at the state a real outage leaves the process in (mt#3682).
 *
 * On 2026-08-07 this host lost its route to the pooler for ~9 hours and PID
 * 34289 came back on its own — same process, no restart, 36.8h uptime at
 * recovery. That was observed once, in the wild, and nothing pinned it. The
 * gap these tests close is narrower than "does it recover": the existing
 * recovery tests above all drive recovery from a NON-escalated degraded state,
 * whereas a multi-hour outage escalates mt#3826's recycle backoff toward its
 * 15-minute ceiling first. The question is whether that backoff, which
 * deliberately stops recycling a port that will never open, also delays
 * noticing that the port opened.
 *
 * It does not, and the reason is structural: recovery runs through the PROBE,
 * which is unthrottled while degraded (`refreshDbReachability`'s healthy-state
 * floor is skipped unless `_dbStatus === "ok"`), while the backoff throttles
 * only the RECYCLE. So these are two independent clocks, and pinning that is
 * what deletes the "escalate to a supervised process restart" design this task
 * was originally filed to add.
 */
describe("unaided recovery under an escalated backoff (mt#3682)", () => {
  function driverError(code: string): Error {
    return Object.assign(new Error(`write ${code} db.example.com:6543`), { code, errno: code });
  }

  /** An init that never settles — the shape a blocked port presents. */
  const hangingFactory: PersistenceServiceFactory = async () =>
    ({
      initialize: () => new Promise<void>(() => {}),
      close: async () => {},
    }) as unknown as PersistenceService;

  const failing = () => Promise.reject(driverError("CONNECT_TIMEOUT"));
  const succeeding = () => Promise.resolve("ok");

  /**
   * One degraded round: re-prime the service (a recycle clears `_initPromise`,
   * and `shouldRecycleNow` correctly refuses to fire with nothing to tear
   * down), then two failing probes either side of a sleep longer than the base
   * recycle floor.
   *
   * The explicit `minIntervalMs: 0` disables the HEALTHY-state probe floor, and
   * it is required rather than incidental: a round that runs immediately after
   * a successful probe finds `_dbStatus === "ok"`, and at the default floor
   * both of its probes are skipped without ever reaching the driver — so the
   * round would observe nothing and AT3 would measure the floor instead of the
   * recycle cadence it is about. The floor's own behavior is covered by
   * "skips a probe inside the healthy-state floor" above.
   */
  async function degradedRound(): Promise<void> {
    void getSharedPersistenceService(60_000, hangingFactory).catch(() => {});
    await refreshDbReachability(failing, 20, 0);
    await new Promise((r) => setTimeout(r, 150));
    await refreshDbReachability(failing, 20, 0);
  }

  const ROUNDS = 10;

  /**
   * Drive the connect-timeout arm until the backoff has escalated past its base
   * floor. Returns the recycle count reached, which is asserted to be BELOW the
   * round count — that inequality is the evidence the backoff actually engaged,
   * so a later assertion about recovery is being made from the intended state
   * rather than from an un-escalated one.
   */
  async function escalateBackoff(): Promise<number> {
    // Degraded-duration threshold 10ms; base recycle floor 100ms.
    __setRecycleThresholdsForTests(10, 100);
    for (let i = 0; i < ROUNDS; i++) await degradedRound();
    const recycles = getDbRecycle().recycleCount;
    expect(recycles).toBeLessThan(ROUNDS);
    return recycles;
  }

  test("a successful probe recovers without a recycle and without a restart (AT1)", async () => {
    const recyclesAtEscalation = await escalateBackoff();
    expect(getDbHealth().failure?.kind).toBe("connect-timeout");

    await refreshDbReachability(succeeding, 50);

    expect(getDbStatus()).toBe("ok");
    const health = getDbHealth();
    expect(health.mode).toBe("connected");
    expect(health.failure).toBeUndefined();
    // The load-bearing assertion: no recycle was needed to get here. If
    // recovery required one, an escalated backoff would gate it behind an
    // interval heading for 15 minutes.
    expect(getDbRecycle().recycleCount).toBe(recyclesAtEscalation);
  }, 30_000);

  test("negative control: the same escalated state, still failing, does not report ok (AT2)", async () => {
    // Without this, AT1 could pass by asserting a state the code reaches
    // unconditionally rather than one the recovering probe produced.
    await escalateBackoff();

    await refreshDbReachability(failing, 20);

    expect(getDbStatus()).not.toBe("ok");
    expect(getDbHealth().mode).not.toBe("connected");
    expect(getDbHealth().failure?.kind).toBe("connect-timeout");
  }, 30_000);

  test("recovery returns the recycle cadence to its floor (AT3)", async () => {
    await escalateBackoff();
    await refreshDbReachability(succeeding, 50);
    const recyclesAtRecovery = getDbRecycle().recycleCount;

    // At the floor, one round recycles once — the same cadence the pool-wedge
    // arm of the mt#3826 test sustains for all 10 of its rounds. Asserted as a
    // count rather than an elapsed interval, so a timing wobble cannot
    // manufacture a result (mem#883).
    await degradedRound();

    expect(getDbRecycle().recycleCount).toBe(recyclesAtRecovery + 1);
  }, 30_000);
});

describe("test-only surface guards (PR #2586 R1)", () => {
  test("__setRecycleThresholdsForTests and __resetSharedPersistenceForTests refuse outside NODE_ENV=test", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => __setRecycleThresholdsForTests(1, 1)).toThrow(/test-only/);
      expect(() => __resetSharedPersistenceForTests()).toThrow(/test-only/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

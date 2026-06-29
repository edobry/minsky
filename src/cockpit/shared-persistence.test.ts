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
  type PersistenceServiceFactory,
} from "./shared-persistence";

const ENV_KEY = "MINSKY_COCKPIT_PERSISTENCE_INIT_TIMEOUT_MS";

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

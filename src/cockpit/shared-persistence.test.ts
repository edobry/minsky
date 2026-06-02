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
  __resetSharedPersistenceForTests,
  type PersistenceServiceFactory,
} from "./shared-persistence";

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
});

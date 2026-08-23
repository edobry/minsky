/**
 * Tests for the live DB-reachability tracker (mt#4466).
 *
 * Every branch is driven through the injected probe/clock seams — no live
 * database, no `spyOn` on a module import. That is the design's own claim
 * (`testing-standards.mdc §Testable Design`) being exercised rather than
 * asserted.
 *
 * The load-bearing case is `reports degraded while a probe never settles`: a
 * query promise that never resolves is the wedge shape this whole module exists
 * to make visible, and it is exactly what a static capability check reports as
 * healthy.
 */

import { describe, expect, test } from "bun:test";
import {
  DbReachabilityTracker,
  REACHABILITY_MIN_INTERVAL_MS,
  REACHABILITY_PROBE_TIMEOUT_MS,
} from "./reachability";

/** A controllable clock, so the healthy-state floor is testable without waiting. */
function makeClock(startMs = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("DbReachabilityTracker", () => {
  test("starts unreachable before any probe has run", () => {
    const tracker = new DbReachabilityTracker({
      probe: () => Promise.resolve(),
      isInitialized: () => true,
    });

    expect(tracker.getStatus()).toBe("unreachable");
    expect(tracker.getCheck()).toEqual({ checkedAt: null, latencyMs: null });
  });

  test("reports ok and records latency when a probe completes", async () => {
    const clock = makeClock();
    const tracker = new DbReachabilityTracker({
      probe: () => Promise.resolve([{ reachable: 1 }]),
      isInitialized: () => true,
      now: clock.now,
    });

    const status = await tracker.refresh();

    expect(status).toBe("ok");
    expect(tracker.getStatus()).toBe("ok");
    const check = tracker.getCheck();
    expect(check.checkedAt).not.toBeNull();
    expect(check.latencyMs).toBe(0);
  });

  test("reports degraded when the probe rejects and a provider IS initialized", async () => {
    const tracker = new DbReachabilityTracker({
      probe: () => Promise.reject(new Error("ECHECKOUTTIMEOUT")),
      isInitialized: () => true,
    });

    expect(await tracker.refresh()).toBe("degraded");
    expect(tracker.getCheck().checkedAt).not.toBeNull();
  });

  test("reports unreachable — not degraded — when no provider is initialized", async () => {
    // The split that keeps a health body actionable: "the pool is wedged" and
    // "there is no pool" have opposite remedies.
    const tracker = new DbReachabilityTracker({
      probe: () => Promise.reject(new Error("no provider")),
      isInitialized: () => false,
    });

    expect(await tracker.refresh()).toBe("unreachable");
  });

  test("reports degraded when the probe throws synchronously, and stamps checkedAt", async () => {
    const tracker = new DbReachabilityTracker({
      probe: () => {
        throw new Error("threw before connecting");
      },
      isInitialized: () => true,
    });

    expect(await tracker.refresh()).toBe("degraded");
    // A synchronous throw DETERMINED reachability, unlike an outstanding probe.
    expect(tracker.getCheck().checkedAt).not.toBeNull();
  });

  test("reports degraded while a probe never settles, and does NOT restamp checkedAt", async () => {
    // THE load-bearing case. A never-settling query is the wedge shape
    // (porsager/postgres#1089) that a static `getCapabilities().sql` check
    // reports as fully healthy — the mem#1120 R2 incident in one test.
    const clock = makeClock();
    let issued = 0;
    const tracker = new DbReachabilityTracker({
      probe: () => {
        issued++;
        return new Promise<never>(() => {
          /* never settles */
        });
      },
      isInitialized: () => true,
      now: clock.now,
      timeoutMs: 5,
    });

    expect(await tracker.refresh()).toBe("degraded");
    const afterFirst = tracker.getCheck().checkedAt;
    expect(afterFirst).not.toBeNull();

    // A later poll must NOT issue a second probe (it would take a second pool
    // slot and also never answer), and must NOT claim a fresh measurement.
    clock.advance(60_000);
    expect(await tracker.refresh()).toBe("degraded");
    expect(issued).toBe(1);
    expect(tracker.getCheck().checkedAt).toBe(afterFirst);
  });

  test("times out a slow probe rather than blocking its caller", async () => {
    const tracker = new DbReachabilityTracker({
      probe: () =>
        new Promise((resolve) => {
          setTimeout(resolve, 10_000);
        }),
      isInitialized: () => true,
      timeoutMs: 5,
    });

    expect(await tracker.refresh()).toBe("degraded");
  });

  test("skips re-probing inside the healthy-state floor", async () => {
    const clock = makeClock();
    let issued = 0;
    const tracker = new DbReachabilityTracker({
      probe: () => {
        issued++;
        return Promise.resolve();
      },
      isInitialized: () => true,
      now: clock.now,
      minIntervalMs: 2_000,
    });

    await tracker.refresh();
    expect(issued).toBe(1);

    clock.advance(500);
    await tracker.refresh();
    expect(issued).toBe(1);

    clock.advance(2_000);
    await tracker.refresh();
    expect(issued).toBe(2);
  });

  test("ignores the healthy-state floor once degraded, so recovery is seen next poll", async () => {
    const clock = makeClock();
    let shouldFail = true;
    let issued = 0;
    const tracker = new DbReachabilityTracker({
      probe: () => {
        issued++;
        return shouldFail ? Promise.reject(new Error("wedged")) : Promise.resolve();
      },
      isInitialized: () => true,
      now: clock.now,
      minIntervalMs: 60_000,
    });

    expect(await tracker.refresh()).toBe("degraded");
    expect(issued).toBe(1);

    // Well inside the floor, but degraded — so it probes anyway and recovers.
    shouldFail = false;
    clock.advance(1);
    expect(await tracker.refresh()).toBe("ok");
    expect(issued).toBe(2);
  });

  test("becomes probeable again after a hung probe finally settles", async () => {
    // The release arm: a pool that recovers must not need a process restart.
    const clock = makeClock();
    let release: (() => void) | undefined;
    let issued = 0;
    const tracker = new DbReachabilityTracker({
      probe: () => {
        issued++;
        if (issued === 1) {
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve();
      },
      isInitialized: () => true,
      now: clock.now,
      timeoutMs: 5,
    });

    expect(await tracker.refresh()).toBe("degraded");
    expect(issued).toBe(1);

    // While still outstanding, no new probe is issued.
    expect(await tracker.refresh()).toBe("degraded");
    expect(issued).toBe(1);

    // The hung query finally comes back; the slot is released.
    release?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(await tracker.refresh()).toBe("ok");
    expect(issued).toBe(2);
  });

  test("a late rejection is reported, not swallowed as an unhandled rejection", async () => {
    const logged: string[] = [];
    let rejectLate: ((err: Error) => void) | undefined;
    const tracker = new DbReachabilityTracker({
      probe: () =>
        new Promise((_resolve, reject) => {
          rejectLate = reject;
        }),
      isInitialized: () => true,
      timeoutMs: 5,
      onLog: (message) => logged.push(message),
    });

    expect(await tracker.refresh()).toBe("degraded");

    rejectLate?.(new Error("ECONNREFUSED, arriving after the deadline"));
    await Promise.resolve();
    await Promise.resolve();

    expect(logged).toContain("DB reachability probe rejected after its deadline");
  });

  test("exposes the cockpit-matched deadline and floor", () => {
    // Pinned because the tray polls every 5s: a deadline above one poll would
    // let a wedge hide between polls.
    expect(REACHABILITY_PROBE_TIMEOUT_MS).toBe(5_000);
    expect(REACHABILITY_MIN_INTERVAL_MS).toBe(2_000);
  });
});

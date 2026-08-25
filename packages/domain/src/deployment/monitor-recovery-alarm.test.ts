/**
 * mt#1495 — check (d): reading a service's DB-pool recovery counters.
 *
 * The load-bearing cases here are the ones that distinguish "no fault" from "no
 * information". A counter defaults to zero both when every recycle released
 * cleanly and when nothing has ever happened, so most of this file exists to pin
 * that those two never collapse into one reading (mem#704).
 */

import { describe, expect, test } from "bun:test";

import {
  classifyRecycleCounters,
  readRecycleCounters,
  toRecoveryCheckSummary,
  type RecycleCounters,
} from "./monitor-recovery-alarm";

/** A counter set with everything at zero — what a freshly booted process reports. */
const zeroed: RecycleCounters = {
  recycleCount: 0,
  closesDrained: 0,
  closesForceTerminated: 0,
  closesAbandoned: 0,
  closesFailed: 0,
  lastRecycleAt: null,
};

const counters = (overrides: Partial<RecycleCounters> = {}): RecycleCounters => ({
  ...zeroed,
  ...overrides,
});

/** The cockpit's real payload shape, verified live 2026-08-25T15:28Z. */
const LIVE_COCKPIT_BODY = {
  status: "ok",
  service: "minsky-cockpit",
  dbRecycle: {
    lastRecycleAt: null,
    recycleCount: 0,
    closesDrained: 0,
    closesForceTerminated: 0,
    closesAbandoned: 0,
    closesFailed: 0,
  },
};

describe("classifyRecycleCounters", () => {
  test("an unexercised mechanism reads UNTESTED, never healthy", () => {
    const reading = classifyRecycleCounters(zeroed);

    expect(reading.state).toBe("untested");
    // The whole point: this must not be sayable as "healthy". A zero here is the
    // absence of evidence, and the detail has to say so out loud because the
    // number itself cannot.
    expect(reading.state === "untested" && reading.detail).toContain("UNEXERCISED");
  });

  test("recycles that all released read HEALTHY", () => {
    const reading = classifyRecycleCounters(
      counters({ recycleCount: 4, closesDrained: 4, lastRecycleAt: "2026-08-25T12:00:00.000Z" })
    );

    expect(reading.state).toBe("healthy");
  });

  test("force-terminated closes are the mt#4515 fix WORKING, not a fault", () => {
    // The single most important non-alarm case. `closesForceTerminated` counts
    // recycles where postgres-js's destroy timer fired and released the
    // connections — i.e. exactly the behaviour mt#4515 shipped. A rule that
    // treated it as a fault would page on every successful recovery.
    const reading = classifyRecycleCounters(
      counters({ recycleCount: 6, closesDrained: 2, closesForceTerminated: 4 })
    );

    expect(reading.state).toBe("healthy");
    expect(reading.state === "healthy" && reading.detail).toContain("WORKING");
  });

  test("an abandoned close is the ALARM", () => {
    const reading = classifyRecycleCounters(
      counters({
        recycleCount: 10,
        closesDrained: 7,
        closesAbandoned: 3,
        lastRecycleAt: "2026-08-24T22:04:24.450Z",
      })
    );

    expect(reading.state).toBe("alarm");
    expect(reading.state === "alarm" && reading.detail).toContain("3 of 10");
  });

  test("a rejected close is DEGRADED, kept out of the alarm counter", () => {
    // mt#4549 split `closesFailed` from `closesAbandoned` during review so the
    // alarm stays trustworthy: a close that errored and said so is a different
    // event from one that never returned.
    const reading = classifyRecycleCounters(
      counters({ recycleCount: 5, closesDrained: 3, closesFailed: 2 })
    );

    expect(reading.state).toBe("degraded");
  });

  test("the alarm wins over the degraded reading when both are non-zero", () => {
    const reading = classifyRecycleCounters(
      counters({ recycleCount: 9, closesAbandoned: 1, closesFailed: 4 })
    );

    expect(reading.state).toBe("alarm");
  });
});

describe("readRecycleCounters", () => {
  test("reads the live cockpit payload", () => {
    // Not a hand-built fixture: this is the body the deployed cockpit actually
    // served, so a field rename upstream fails here rather than silently
    // reporting no-surface.
    expect(readRecycleCounters(LIVE_COCKPIT_BODY).state).toBe("untested");
  });

  test("a service with no dbRecycle key reads NO-SURFACE, not healthy", () => {
    expect(readRecycleCounters({ status: "ok", service: "minsky-mcp" }).state).toBe("no-surface");
  });

  test("a PARTIAL dbRecycle is unparseable rather than zero-filled", () => {
    // The failure this guards: projecting over a payload that lacks these keys
    // manufactures `undefined` for each, and `undefined > 0` is false — so a
    // half-present payload would have read as "healthy, nothing abandoned".
    const reading = readRecycleCounters({
      dbRecycle: { recycleCount: 3, closesDrained: 3 },
    });

    expect(reading.state).toBe("unparseable");
    expect(reading.state === "unparseable" && reading.detail).toContain("closesAbandoned");
  });

  test("non-integer counters are unparseable", () => {
    const reading = readRecycleCounters({
      dbRecycle: { ...LIVE_COCKPIT_BODY.dbRecycle, closesAbandoned: "3" },
    });

    expect(reading.state).toBe("unparseable");
  });

  test("a non-object body is unparseable", () => {
    expect(readRecycleCounters(null).state).toBe("unparseable");
    expect(readRecycleCounters("Service Unavailable").state).toBe("unparseable");
  });
});

describe("toRecoveryCheckSummary", () => {
  test("UNTESTED maps to not-applicable so a process restart cannot fake a recovery", () => {
    // This is the mapping's whole reason for existing. `outcome: "ok"` with
    // `problem: false` is read by observedRecoveredClasses as POSITIVE evidence
    // of recovery — so if untested mapped to `ok`, restarting the cockpit (which
    // zeroes every counter) would close the very P0 its abandoned closes opened.
    const summary = toRecoveryCheckSummary(classifyRecycleCounters(zeroed));

    expect(summary.outcome).toBe("not-applicable");
    expect(summary.problem).toBe(false);
  });

  test("HEALTHY maps to ok with no problem", () => {
    const summary = toRecoveryCheckSummary(
      classifyRecycleCounters(counters({ recycleCount: 2, closesDrained: 2 }))
    );

    expect(summary).toMatchObject({ outcome: "ok", problem: false });
  });

  test("ALARM maps to a real problem on a check that ran", () => {
    const summary = toRecoveryCheckSummary(
      classifyRecycleCounters(counters({ recycleCount: 3, closesAbandoned: 3 }))
    );

    expect(summary).toMatchObject({ outcome: "ok", problem: true });
  });

  test("UNPARSEABLE maps to a failed check, not to a problem", () => {
    // mt#3921's rule: a check that could not run has observed nothing. It makes
    // the service DEGRADED without claiming a fault was found.
    const summary = toRecoveryCheckSummary(readRecycleCounters({ dbRecycle: 12 }));

    expect(summary).toMatchObject({ outcome: "failed", problem: false });
  });

  test("NO-SURFACE maps to not-applicable", () => {
    const summary = toRecoveryCheckSummary(readRecycleCounters({ service: "minsky-mcp" }));

    expect(summary).toMatchObject({ outcome: "not-applicable", problem: false });
  });
});

/**
 * mt#4384 — `/api/health` must not read as healthy while a sweep is wedged.
 *
 * The pure derivation is asserted directly rather than through an HTTP harness: the
 * question is what the payload SAYS about a given registry state, and routing it through
 * express would add a moving part without adding an assertion.
 */
import { describe, expect, test } from "bun:test";
import { deriveHealthSweepLiveness, MAX_LISTED_ABANDONED_SWEEPS } from "./health-sweep-liveness";
import type { SweepLivenessSnapshot } from "./sweepers";

const NOW = "2026-08-22T02:40:00.000Z";

/** A healthy, currently-reporting interval sweep. Override to build the case under test. */
function sweep(overrides: Partial<SweepLivenessSnapshot> = {}): SweepLivenessSnapshot {
  return {
    name: "healthy sweep",
    intervalMs: 600_000,
    lastAttemptAt: NOW,
    lastSuccessAt: NOW,
    lastErrorAt: null,
    consecutiveFailures: 0,
    reinits: 0,
    metaRestarts: 0,
    lastDomainSuccessAt: NOW,
    lastDomainFailureAt: null,
    consecutiveDomainFailures: 0,
    reportsDomainOutcome: true,
    declaresDomainOutcome: true,
    abandonedTicks: 0,
    abandonedTicksOutstanding: 0,
    abandonedTickHardReleases: 0,
    selfScheduled: false,
    registeredAt: NOW,
    ...overrides,
  };
}

/**
 * The wedge, as measured on 2026-08-21: a tick that overran its budget and was
 * abandoned with its guard still held. Note every DOMAIN field is at its clean value —
 * that is not a fixture convenience, it is the actual shape, and it is the whole reason
 * `/api/health` could not see this.
 */
function wedged(name: string): SweepLivenessSnapshot {
  return sweep({
    name,
    lastSuccessAt: null,
    lastErrorAt: null,
    consecutiveFailures: 0,
    lastDomainSuccessAt: null,
    lastDomainFailureAt: null,
    consecutiveDomainFailures: 0,
    reportsDomainOutcome: false,
    abandonedTicks: 1,
    abandonedTicksOutstanding: 1,
  });
}

describe("/api/health sweepLiveness (mt#4384)", () => {
  test("AT1: a wedged sweep is visible, and named, on the health payload", () => {
    const out = deriveHealthSweepLiveness(
      [sweep(), wedged("dispatch watchdog"), wedged("conversation presence")],
      NOW
    );

    expect(out.abandonedTicksOutstanding).toBe(2);
    expect(out.abandonedSweeps).toEqual(["conversation presence", "dispatch watchdog"]);
    expect(out.abandonedSweepsTruncated).toBe(false);
    // The pointer is part of the payload rather than folklore.
    expect(out.authoritativeSurface).toBe("/api/sweeps");
    // Dating, per health-liveness-invariant.ts. `checkedAt` rather than
    // `lastAttemptAt` (PR #3240 R1): this dates the READ, and nothing here attempts
    // anything — the same meaning `dbCheck.checkedAt` already carries.
    expect(out.checkedAt).toBe(NOW);
  });

  test("AT2 negative control: every DOMAIN field the pre-fix payload carried reads CLEAN through the same wedge", () => {
    // This is the pre-mt#4384 surface. `/api/health` embedded only the domain
    // trackers, and those are what a domain tracker reports — so for a wedged sweep
    // it showed exactly this, which is indistinguishable from a healthy sweep that
    // simply has not finished its first tick.
    const stuck = wedged("prod-state refresh");

    expect(stuck.lastErrorAt).toBeNull();
    expect(stuck.consecutiveFailures).toBe(0);
    expect(stuck.lastDomainFailureAt).toBeNull();
    expect(stuck.consecutiveDomainFailures).toBe(0);

    // Not one of those four fields distinguishes it. The new field does, from the
    // very same snapshot — which is the point: no new measurement was needed, only a
    // surface that reads the layer already holding the answer.
    const out = deriveHealthSweepLiveness([stuck], NOW);
    expect(out.abandonedTicksOutstanding).toBeGreaterThan(0);
    expect(out.abandonedSweeps).toContain("prod-state refresh");
  });

  test("a healthy registry reports no abandonment and does not manufacture alarm", () => {
    const out = deriveHealthSweepLiveness([sweep(), sweep({ name: "b" })], NOW);

    expect(out.registrants).toBe(2);
    expect(out.abandonedTicksOutstanding).toBe(0);
    expect(out.abandonedSweeps).toEqual([]);
    expect(out.abandonedSweepsTruncated).toBe(false);
  });

  test("reporting legitimately trails declaring after a restart — low is not a defect", () => {
    // mt#4412's split: every registrant DECLARES an outcome statically, but the
    // runtime flag flips only once a tick completes. Shortly after a restart the two
    // numbers differ for entirely healthy reasons, so a reader must not treat a low
    // `reportingDomainOutcome` as a fault on its own.
    const out = deriveHealthSweepLiveness(
      [sweep(), sweep({ name: "not yet ticked", reportsDomainOutcome: false })],
      NOW
    );

    expect(out.declaringDomainOutcome).toBe(2);
    expect(out.reportingDomainOutcome).toBe(1);
    // And crucially: nothing is abandoned, so the trailing count carries no alarm.
    expect(out.abandonedTicksOutstanding).toBe(0);
  });

  test("the listed-sweep array is bounded, and says so rather than ending silently", () => {
    const many = Array.from({ length: MAX_LISTED_ABANDONED_SWEEPS + 3 }, (_, i) =>
      wedged(`sweep-${String(i).padStart(2, "0")}`)
    );

    const out = deriveHealthSweepLiveness(many, NOW);

    expect(out.abandonedSweeps).toHaveLength(MAX_LISTED_ABANDONED_SWEEPS);
    expect(out.abandonedSweepsTruncated).toBe(true);
    // The COUNT is never truncated — the aggregate stays true even when the list is cut.
    expect(out.abandonedTicksOutstanding).toBe(MAX_LISTED_ABANDONED_SWEEPS + 3);
  });
});

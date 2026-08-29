/**
 * `computeReviewDueLogs` tests (mt#2896) — split out of
 * `calibration-sweep.test.ts` by mt#3179.
 *
 * Why the split: the parent file reached the 1500-line `max-lines` error
 * ceiling (eslint.config.js). Two detector PRs landing in the same window
 * (mt#2459's operator-deferral and mt#3179's untaken-action) each added a
 * registry entry plus its fixture, which pushed it over. This block was the
 * cleanest extraction — it is a self-contained describe with no dependency on
 * the parent file's local record-builder helpers, only on imported functions
 * and constants.
 */
import { describe, test, expect } from "bun:test";
import {
  computeReviewDueLogs,
  STALE_DAYS_MS,
  NEVER_REVIEWED_DAYS,
  type CalibrationLogEntry,
  type CalibrationLogResult,
  type WatermarkStore,
} from "./calibration-sweep";

const RETRO_KIND = "retrospective-trigger";
const DEFERRAL_KIND = "ask-routing-deferral";
const BUILD_CLAIM_INJECTION_KIND = "build-claim-injection";

describe("computeReviewDueLogs (mt#2896)", () => {
  const NOW = Date.parse("2026-07-21T00:00:00Z");
  const DAY = 24 * 60 * 60 * 1000;

  function reviewEntry(
    name: string,
    overrides: Partial<CalibrationLogEntry> = {}
  ): CalibrationLogEntry {
    return {
      path: `.minsky/${name}-calibration.jsonl`,
      name,
      kind: "causal-premise",
      ...overrides,
    };
  }

  function reviewResult(
    entry: CalibrationLogEntry,
    overrides: Partial<CalibrationLogResult> = {}
  ): CalibrationLogResult {
    const merged = {
      entry,
      exists: true,
      totalFires: 0,
      firesSinceLastReview: 0,
      suppressedSinceLastReview: 0,
      injectedFiresSinceLastReview: 0,
      evaluatedOnlySinceLastReview: 0,
      distinctPhrases: 0,
      atCountThreshold: false,
      lowDiversity: false,
      pastThreshold: false,
      newRecords: [],
      watermarkCount: 0,
      // mt#3610: every result carries a classifiability verdict. These fixtures
      // exercise the review-due legs, which don't consult it, so the empty-log
      // verdict is the honest default — a fixture with no records.
      classifiability: {
        verdict: "no-records" as const,
        evidenceFields: [],
        recordsAssessed: 0,
        // mt#3898: recoverability rides alongside the verdict. A no-records
        // fixture is `no-records` on both — an empty log has no judged text to
        // have lost, which is a different state from one whose text is gone.
        judgedText: {
          recoverability: "no-records" as const,
          capturedRecords: 0,
          recoverableRecords: 0,
          recordsAssessed: 0,
        },
      },
      ...overrides,
    };
    return {
      ...merged,
      // mt#3197: DERIVE the injected count unless a test sets it explicitly.
      // A flat `0` default would silently gate out every pre-existing fixture
      // that only sets `firesSinceLastReview`, since the review-due legs now
      // key off the injected count.
      injectedFiresSinceLastReview:
        overrides.injectedFiresSinceLastReview ??
        merged.firesSinceLastReview - merged.suppressedSinceLastReview,
    };
  }

  test("condition 1 — flags a pastThreshold log with reason past-threshold", () => {
    const entry = reviewEntry(DEFERRAL_KIND);
    const results = [
      reviewResult(entry, {
        pastThreshold: true,
        firesSinceLastReview: 43,
        totalFires: 43,
        distinctPhrases: 31,
      }),
    ];
    const due = computeReviewDueLogs(results, {}, NOW);
    expect(due).toHaveLength(1);
    expect(due[0]?.reason).toBe("past-threshold");
  });

  test("condition 2 — flags a reviewed-but-stale log with reason time-stale", () => {
    const entry = reviewEntry(RETRO_KIND);
    const results = [reviewResult(entry, { firesSinceLastReview: 8, totalFires: 20 })];
    const watermarks: WatermarkStore = {
      [entry.path]: {
        lastReviewedCount: 12,
        lastReviewedAt: new Date(NOW - (STALE_DAYS_MS + DAY)).toISOString(),
      },
    };
    const due = computeReviewDueLogs(results, watermarks, NOW);
    expect(due).toHaveLength(1);
    expect(due[0]?.reason).toBe("time-stale");
  });

  test("condition 3 — flags a NEVER-reviewed log whose first fire is >= 30 days old (the causal-premise blind spot)", () => {
    const entry = reviewEntry("causal-premise");
    const results = [
      reviewResult(entry, {
        totalFires: 1,
        firesSinceLastReview: 1,
        firstRecordTimestamp: new Date(NOW - 31 * DAY).toISOString(),
      }),
    ];
    const due = computeReviewDueLogs(results, {}, NOW);
    expect(due).toHaveLength(1);
    expect(due[0]?.reason).toBe("never-reviewed");
    expect(due[0]?.name).toBe("causal-premise");
    expect(due[0]?.reviewByDays).toBe(NEVER_REVIEWED_DAYS);
  });

  test("condition 3 — does NOT flag a never-reviewed log below the 30-day bar (29 days)", () => {
    const entry = reviewEntry("causal-premise");
    const results = [
      reviewResult(entry, {
        totalFires: 1,
        firesSinceLastReview: 1,
        firstRecordTimestamp: new Date(NOW - 29 * DAY).toISOString(),
      }),
    ];
    expect(computeReviewDueLogs(results, {}, NOW)).toHaveLength(0);
  });

  test("condition 3 — never-reviewed boundary is inclusive at exactly 30 days", () => {
    const entry = reviewEntry("causal-premise");
    const results = [
      reviewResult(entry, {
        totalFires: 1,
        firesSinceLastReview: 1,
        firstRecordTimestamp: new Date(NOW - NEVER_REVIEWED_DAYS * DAY).toISOString(),
      }),
    ];
    expect(computeReviewDueLogs(results, {}, NOW)).toHaveLength(1);
  });

  test("per-entry reviewByDays override tightens the never-reviewed window (7 days)", () => {
    const entry = reviewEntry("learn-capture", { reviewByDays: 7 });
    const at8 = [
      reviewResult(entry, {
        totalFires: 2,
        firesSinceLastReview: 2,
        firstRecordTimestamp: new Date(NOW - 8 * DAY).toISOString(),
      }),
    ];
    const at6 = [
      reviewResult(entry, {
        totalFires: 2,
        firesSinceLastReview: 2,
        firstRecordTimestamp: new Date(NOW - 6 * DAY).toISOString(),
      }),
    ];
    expect(computeReviewDueLogs(at8, {}, NOW)[0]?.reason).toBe("never-reviewed");
    expect(computeReviewDueLogs(at8, {}, NOW)[0]?.reviewByDays).toBe(7);
    expect(computeReviewDueLogs(at6, {}, NOW)).toHaveLength(0);
  });

  test("never-reviewed leg ignores 0 fires, a missing first timestamp, and a malformed one", () => {
    const entry = reviewEntry("causal-premise");
    const zeroFires = [
      reviewResult(entry, {
        totalFires: 0,
        firesSinceLastReview: 0,
        firstRecordTimestamp: new Date(NOW - 90 * DAY).toISOString(),
      }),
    ];
    const noTs = [reviewResult(entry, { totalFires: 3, firesSinceLastReview: 3 })];
    const badTs = [
      reviewResult(entry, {
        totalFires: 3,
        firesSinceLastReview: 3,
        firstRecordTimestamp: "not-a-date",
      }),
    ];
    expect(computeReviewDueLogs(zeroFires, {}, NOW)).toHaveLength(0);
    expect(computeReviewDueLogs(noTs, {}, NOW)).toHaveLength(0);
    expect(computeReviewDueLogs(badTs, {}, NOW)).toHaveLength(0);
  });

  test("a reviewed log (watermark present, 0 new fires) never takes the never-reviewed leg", () => {
    const entry = reviewEntry("causal-premise");
    const results = [
      reviewResult(entry, {
        totalFires: 5,
        firesSinceLastReview: 0,
        firstRecordTimestamp: new Date(NOW - 90 * DAY).toISOString(),
      }),
    ];
    const watermarks: WatermarkStore = {
      [entry.path]: { lastReviewedCount: 5, lastReviewedAt: new Date(NOW - DAY).toISOString() },
    };
    expect(computeReviewDueLogs(results, watermarks, NOW)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // condition 4 — never-fired (mt#3078): a detector with ZERO total fires and
  // no watermark, but its registry entry declares `liveSinceDate` (confirmed
  // alive via a live synthetic test). Closes the residual blind spot: a
  // detector whose real-world trigger is a rare compound condition can sit at
  // true-zero fires forever, which condition 3 (never-reviewed) can't reach
  // because it requires >=1 fire to anchor from.
  // -------------------------------------------------------------------------

  test("condition 4 — flags a zero-fire log whose liveSinceDate is >= the review window old", () => {
    const entry = reviewEntry(BUILD_CLAIM_INJECTION_KIND, {
      reviewByDays: 30,
      liveSinceDate: new Date(NOW - 31 * DAY).toISOString(),
    });
    const results = [reviewResult(entry, { totalFires: 0, firesSinceLastReview: 0 })];
    const due = computeReviewDueLogs(results, {}, NOW);
    expect(due).toHaveLength(1);
    expect(due[0]?.reason).toBe("never-fired");
    expect(due[0]?.reviewByDays).toBe(30);
  });

  test("condition 4 — does NOT flag a zero-fire log whose liveSinceDate is within the review window (29 days)", () => {
    const entry = reviewEntry(BUILD_CLAIM_INJECTION_KIND, {
      reviewByDays: 30,
      liveSinceDate: new Date(NOW - 29 * DAY).toISOString(),
    });
    const results = [reviewResult(entry, { totalFires: 0, firesSinceLastReview: 0 })];
    expect(computeReviewDueLogs(results, {}, NOW)).toHaveLength(0);
  });

  test("condition 4 — does NOT flag a zero-fire log with no liveSinceDate declared (silent forever, unchanged pre-mt#3078 behavior)", () => {
    const entry = reviewEntry("some-other-detector");
    const results = [reviewResult(entry, { totalFires: 0, firesSinceLastReview: 0 })];
    expect(computeReviewDueLogs(results, {}, NOW)).toHaveLength(0);
  });

  test("condition 4 — a malformed liveSinceDate is ignored (never flagged, not a throw)", () => {
    const entry = reviewEntry(BUILD_CLAIM_INJECTION_KIND, {
      reviewByDays: 30,
      liveSinceDate: "not-a-date",
    });
    const results = [reviewResult(entry, { totalFires: 0, firesSinceLastReview: 0 })];
    expect(computeReviewDueLogs(results, {}, NOW)).toHaveLength(0);
  });

  test("condition 4 — a non-zero-fire log ignores liveSinceDate entirely and takes the never-reviewed leg instead", () => {
    const entry = reviewEntry(BUILD_CLAIM_INJECTION_KIND, {
      reviewByDays: 30,
      liveSinceDate: new Date(NOW - 90 * DAY).toISOString(),
    });
    const results = [
      reviewResult(entry, {
        totalFires: 1,
        firesSinceLastReview: 1,
        firstRecordTimestamp: new Date(NOW - 1 * DAY).toISOString(),
      }),
    ];
    // firstRecordTimestamp is only 1 day old -> not past the 30-day window,
    // so this should NOT be flagged via either leg once totalFires > 0.
    expect(computeReviewDueLogs(results, {}, NOW)).toHaveLength(0);
  });
});

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
  FIRES_THRESHOLD,
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
      // mt#4904: DERIVED from the same comparison production uses, not defaulted
      // to false. A fixture that sets a watermark above its record count IS
      // stranded, and hardcoding false here would let such a fixture assert a
      // review-due reason the real sweep would never produce for it.
      watermarkStranded: overrides.watermarkStranded ?? merged.watermarkCount > merged.totalFires,
      // mt#4049: DERIVED, same reasoning as the two above — a fixture whose
      // records were all suppressed at volume IS all-suppressed, so hardcoding
      // false would let it assert an exclusion the real sweep no longer makes.
      allSuppressed:
        overrides.allSuppressed ??
        ((overrides.injectedFiresSinceLastReview ??
          merged.firesSinceLastReview - merged.suppressedSinceLastReview) === 0 &&
          merged.suppressedSinceLastReview >= FIRES_THRESHOLD),
      // mt#4970: defaults to 0 — a fixture that does not mention a log-only
      // family has none, which is every detector but `untaken-action` today.
      logOnlyFamilySinceLastReview: overrides.logOnlyFamilySinceLastReview ?? 0,
      // mt#4970: DERIVED, same reasoning as the three above. With the default 0
      // above this reduces to `allSuppressed` for every existing fixture, so no
      // prior case changes behavior — which is the property the additive claim
      // rests on.
      allWithheld:
        overrides.allWithheld ??
        ((overrides.injectedFiresSinceLastReview ??
          merged.firesSinceLastReview - merged.suppressedSinceLastReview) === 0 &&
          merged.suppressedSinceLastReview + (overrides.logOnlyFamilySinceLastReview ?? 0) >=
            FIRES_THRESHOLD),
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

  // -------------------------------------------------------------------------
  // condition 0 — watermark-stranded (mt#4904)
  // -------------------------------------------------------------------------

  test("condition 0 — flags a log whose watermark EXCEEDS its record count", () => {
    // The measured production shape: `untaken-action` after mt#4748 re-rooted
    // the streams to the project-keyed state dir while the watermark store kept
    // the count recorded against the larger pre-migration log.
    const entry = reviewEntry("untaken-action");
    const results = [
      reviewResult(entry, {
        totalFires: 121,
        // Clamped by `Math.max(0, 121 - 424)` in production — which is exactly
        // what makes this indistinguishable from a just-reviewed log.
        firesSinceLastReview: 0,
        watermarkCount: 424,
      }),
    ];
    const watermarks: WatermarkStore = {
      [entry.path]: {
        lastReviewedCount: 424,
        lastReviewedAt: new Date(NOW - DAY).toISOString(),
      },
    };
    const due = computeReviewDueLogs(results, watermarks, NOW);
    expect(due).toHaveLength(1);
    expect(due[0]?.reason).toBe("watermark-stranded");
    expect(due[0]?.name).toBe("untaken-action");
  });

  test("condition 0 — fires even though every OTHER leg declines a stranded log", () => {
    // The point of the leg, stated as an assertion rather than a comment: all
    // four pre-existing legs decline this input. `past-threshold` and
    // `time-stale` are gated on a zero injected count; `never-reviewed` and
    // `never-fired` require NO watermark, and this log has one. Before mt#4904
    // the result was an EMPTY due-list — permanent invisibility, no error.
    const entry = reviewEntry(RETRO_KIND);
    const stranded = reviewResult(entry, {
      totalFires: 181,
      firesSinceLastReview: 0,
      injectedFiresSinceLastReview: 0,
      watermarkCount: 2338,
      pastThreshold: false,
      // Old enough to satisfy time-stale's staleness bar, so the ONLY thing
      // holding that leg back is the injected-count gate — which is what makes
      // this the load-bearing case rather than a trivially-declined one.
      firstRecordTimestamp: new Date(NOW - 60 * DAY).toISOString(),
    });
    const watermarks: WatermarkStore = {
      [entry.path]: {
        lastReviewedCount: 2338,
        lastReviewedAt: new Date(NOW - (STALE_DAYS_MS + DAY)).toISOString(),
      },
    };

    expect(stranded.watermarkStranded).toBe(true);
    const due = computeReviewDueLogs([stranded], watermarks, NOW);
    expect(due).toHaveLength(1);
    expect(due[0]?.reason).toBe("watermark-stranded");
  });

  test("condition 0 — a watermark EQUAL to the record count is NOT stranded", () => {
    // The discriminator this whole leg turns on. A genuinely-just-reviewed log
    // has watermark === totalFires and must stay quiet; only a watermark ABOVE
    // the count means the comparison basis is gone. An off-by-one here would
    // make every reviewed log permanently review-due — the inverse failure.
    const entry = reviewEntry(DEFERRAL_KIND);
    const results = [
      reviewResult(entry, {
        totalFires: 50,
        firesSinceLastReview: 0,
        watermarkCount: 50,
      }),
    ];
    const watermarks: WatermarkStore = {
      [entry.path]: {
        lastReviewedCount: 50,
        lastReviewedAt: new Date(NOW - DAY).toISOString(),
      },
    };
    expect(results[0]?.watermarkStranded).toBe(false);
    expect(computeReviewDueLogs(results, watermarks, NOW)).toHaveLength(0);
  });

  test("condition 0 — does NOT flag an ABSENT log, however large its watermark", () => {
    // Found by live verification, not by reasoning about the code: the first
    // run surfaced 15 streams where 13 were stranded. The two extras were
    // `exists: false` with `totalFires: 0`, which any watermark exceeds —
    // `policy-coverage` among them, retired by mt#4197 with a watermark of 1760
    // against a file that no longer exists. "Review these fires" is the wrong
    // thing to say about a log that has neither fires nor a file.
    const entry = reviewEntry("policy-coverage");
    const results = [
      reviewResult(entry, {
        exists: false,
        totalFires: 0,
        firesSinceLastReview: 0,
        watermarkCount: 1760,
      }),
    ];
    const watermarks: WatermarkStore = {
      [entry.path]: {
        lastReviewedCount: 1760,
        lastReviewedAt: new Date(NOW - DAY).toISOString(),
      },
    };
    // The FIELD is still true — the comparison genuinely holds. It is the review
    // -due LEG that declines, so the distinction stays visible to a reader.
    expect(results[0]?.watermarkStranded).toBe(true);
    expect(computeReviewDueLogs(results, watermarks, NOW)).toHaveLength(0);
  });

  test("condition 0 — does not preempt past-threshold for a healthy log", () => {
    // Ordering guard: the stranded leg runs FIRST, so a healthy past-threshold
    // log must still report its own reason rather than being swallowed.
    const entry = reviewEntry(DEFERRAL_KIND);
    const results = [
      reviewResult(entry, {
        pastThreshold: true,
        firesSinceLastReview: 43,
        totalFires: 43,
        distinctPhrases: 31,
        watermarkCount: 0,
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

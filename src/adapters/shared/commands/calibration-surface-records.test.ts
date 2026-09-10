/**
 * The renderer and the producer must agree on whether to surface records (mt#5047).
 *
 * `computeLogResult` decides whether to POPULATE `newRecords`; the text renderer
 * decides whether to PRINT them. They were hand-mirrored, and the mirror broke
 * twice in the same direction:
 *
 *   - mt#4049 widened the producer to `atCountThreshold || allSuppressed`; the
 *     renderer stayed on `atCountThreshold` alone. Reviewer-caught.
 *   - mt#4970 widened the producer again to `allWithheld` (suppressed PLUS
 *     log-only-family); the renderer stayed on `allSuppressed`.
 *
 * Both times a log was routed for review and shown nothing. mt#5047 extracts
 * `shouldSurfaceRecords` so neither side restates the condition.
 *
 * The load-bearing test is the LAST one: it asserts the renderer's output
 * against the predicate itself, so a future divergence fails here rather than
 * being noticed by a reviewer three months later.
 */

import { describe, expect, test } from "bun:test";
import { shouldSurfaceRecords } from "../../../domain/calibration/calibration-sweep";
import type { CalibrationLogResult } from "../../../domain/calibration/calibration-sweep";
import { formatResult } from "./calibration";

/**
 * Short deliberately: the renderer truncates a match line to a fixed width, so a
 * long fixture phrase would be cut mid-word and the assertion below would be
 * testing the truncator rather than the gate.
 */
const PHRASE = "the phrase to see";

/**
 * A result whose only volume is LOG-ONLY family — `allWithheld` true,
 * `allSuppressed` false, below the count bar. This is the shape the renderer
 * dropped, and it is not hypothetical: it is what a Rung-1 record-only detector
 * produces (mt#5010 gave `stale-state-assertion` the parse branch that makes
 * this population reachable).
 */
function logOnlyResult(overrides: Partial<CalibrationLogResult> = {}): CalibrationLogResult {
  return {
    entry: {
      name: "stale-state-assertion",
      path: ".minsky/stale-state-assertion-calibration.jsonl",
    },
    exists: true,
    totalFires: 40,
    firesSinceLastReview: 6,
    suppressedSinceLastReview: 0,
    injectedFiresSinceLastReview: 0,
    evaluatedOnlySinceLastReview: 0,
    logOnlyFamilySinceLastReview: 6,
    distinctFiresSinceLastReview: 6,
    ungroupableSinceLastReview: 0,
    distinctPhrases: 6,
    atCountThreshold: false,
    lowDiversity: false,
    pastThreshold: false,
    allSuppressed: false,
    allWithheld: true,
    newRecords: [
      {
        timestamp: "2026-09-09T12:00:00.000Z",
        matches: [{ family: "past-tense-claim", phrase: PHRASE, logOnly: true }],
        contradicted: [],
        fired: true,
        resolvedCount: 1,
      },
    ] as unknown as CalibrationLogResult["newRecords"],
    watermarkCount: 34,
    watermarkStranded: false,
    classifiability: {
      verdict: "classifiable",
      evidenceFields: ["matches"],
      recordsAssessed: 1,
      judgedText: {
        recoverability: "recoverable",
        recoverableRecords: 1,
        recordsAssessed: 1,
        capturedRecords: 0,
      },
    } as unknown as CalibrationLogResult["classifiability"],
    ...overrides,
  } as CalibrationLogResult;
}

describe("shouldSurfaceRecords (mt#5047)", () => {
  test("an all-withheld log surfaces, even below the count bar", () => {
    expect(shouldSurfaceRecords({ atCountThreshold: false, allWithheld: true })).toBe(true);
  });

  test("a past-count log surfaces", () => {
    expect(shouldSurfaceRecords({ atCountThreshold: true, allWithheld: false })).toBe(true);
  });

  test("a quiet log does not", () => {
    expect(shouldSurfaceRecords({ atCountThreshold: false, allWithheld: false })).toBe(false);
  });
});

describe("the renderer honours it (mt#5047 SC1/AT1)", () => {
  test("AT1: a log-only-family log's records are PRINTED", () => {
    // The negative control, by construction: against the pre-mt#5047 renderer
    // this result has `allSuppressed: false` and `atCountThreshold: false`, so
    // the old `(atCountThreshold || allSuppressed)` gate is false and no record
    // block is emitted. The reviewer is handed a routed log and nothing to judge.
    const out = formatResult([logOnlyResult()], []);

    expect(out).toContain("New records (1)");
    expect(out).toContain(PHRASE);
  });

  test("AT2: an all-SUPPRESSED log still renders — no regression on the mt#4049 leg", () => {
    const out = formatResult(
      [
        logOnlyResult({
          allSuppressed: true,
          allWithheld: true,
          suppressedSinceLastReview: 6,
          logOnlyFamilySinceLastReview: 0,
        }),
      ],
      []
    );

    expect(out).toContain("New records (1)");
  });

  test("AT3: a log below every threshold renders no record block", () => {
    const out = formatResult([logOnlyResult({ allWithheld: false, newRecords: [] })], []);

    expect(out).not.toContain("New records");
  });

  test("SC2: the renderer's decision equals the predicate, across the whole truth table", () => {
    // This is the agreement pin. It asserts the renderer against
    // `shouldSurfaceRecords` rather than against a duplicated boolean
    // expression, so widening the predicate later cannot silently desync them —
    // which is exactly how this defect arrived twice.
    for (const atCountThreshold of [true, false]) {
      for (const allWithheld of [true, false]) {
        const result = logOnlyResult({ atCountThreshold, allWithheld });
        const rendered = formatResult([result], []).includes("New records (1)");

        expect(rendered).toBe(shouldSurfaceRecords({ atCountThreshold, allWithheld }));
      }
    }
  });
});

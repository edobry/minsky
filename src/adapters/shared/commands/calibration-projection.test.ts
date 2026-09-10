/**
 * The `--json` projection must carry every field a consumer is told to read
 * (mt#5011).
 *
 * `CalibrationLogResult` gained `logOnlyFamilySinceLastReview` (mt#4970),
 * `allSuppressed` (mt#4049) and `allWithheld` (mt#4970); none reached the
 * adapter's projection literal. The text path rendered the first, so the gap was
 * specific to the JSON consumer — which is the path `/calibration-review` Step 1
 * instructs an agent to read. The absence surfaced as `null`, which is
 * byte-identical to a real zero: a projection over a missing key is a
 * constructor, not a filter (`CLAUDE.md §Claim Confidence`, mt#4227), so there
 * was no error to notice.
 *
 * The load-bearing test here is the KEY DIFF, not the three-field assertion. A
 * test naming only the three fields would pass forever while the fourth omission
 * shipped exactly the same way.
 */

import { describe, expect, test } from "bun:test";
import type { CalibrationLogResult } from "../../../domain/calibration/calibration-sweep";
import { PROJECTION_EXEMPT_RESULT_FIELDS, projectCalibrationLogResult } from "./calibration";

/**
 * Every field of `CalibrationLogResult`, enumerated so it can be read at
 * RUNTIME — TypeScript types are erased, so a type alone cannot be diffed.
 *
 * `Record<keyof T, true>` is what makes this safe to rely on: it requires EVERY
 * key, optional ones included, so adding a field to the domain result fails
 * compilation HERE until it is listed. That is the mechanism — without it this
 * enumeration would silently drift out of date and the diff below would compare
 * a stale list against the projection and pass.
 */
const DOMAIN_RESULT_FIELDS: Record<keyof CalibrationLogResult, true> = {
  entry: true,
  exists: true,
  totalFires: true,
  firesSinceLastReview: true,
  suppressedSinceLastReview: true,
  injectedFiresSinceLastReview: true,
  evaluatedOnlySinceLastReview: true,
  logOnlyFamilySinceLastReview: true,
  undeterminedSinceLastReview: true,
  distinctFiresSinceLastReview: true,
  ungroupableSinceLastReview: true,
  distinctPhrases: true,
  atCountThreshold: true,
  lowDiversity: true,
  pastThreshold: true,
  allSuppressed: true,
  allWithheld: true,
  newRecords: true,
  watermarkCount: true,
  watermarkStranded: true,
  openAskId: true,
  firstRecordTimestamp: true,
  classifiability: true,
};

/**
 * Values are irrelevant to a key diff — the projection is a static literal, so
 * its key set does not vary with input. Only the two fields the projection
 * DEREFERENCES need real shapes: `entry` (for `name`/`path`) and `newRecords`
 * (for `.length`).
 */
function stubResult(overrides: Partial<CalibrationLogResult> = {}): CalibrationLogResult {
  return {
    entry: { name: "untaken-action", path: ".minsky/untaken-action-calibration.jsonl" },
    newRecords: [],
    ...overrides,
  } as unknown as CalibrationLogResult;
}

describe("projectCalibrationLogResult key coverage (mt#5011)", () => {
  test("every domain field is projected or explicitly exempt", () => {
    const projected = new Set(Object.keys(projectCalibrationLogResult(stubResult())));
    const missing = Object.keys(DOMAIN_RESULT_FIELDS).filter(
      (field) => !projected.has(field) && !PROJECTION_EXEMPT_RESULT_FIELDS.has(field)
    );

    // Named in the failure so a future omission reports WHICH field, rather
    // than a bare count the next reader has to re-derive.
    expect(missing).toEqual([]);
  });

  test("the exempt set is not a dumping ground — every entry is a real domain field", () => {
    const domainFields = new Set(Object.keys(DOMAIN_RESULT_FIELDS));
    const stale = [...PROJECTION_EXEMPT_RESULT_FIELDS].filter((f) => !domainFields.has(f));

    expect(stale).toEqual([]);
  });

  test("`entry` is exempt because it is DECOMPOSED, not dropped", () => {
    const projected = projectCalibrationLogResult(
      stubResult({ entry: { name: "n", path: "p" } as CalibrationLogResult["entry"] })
    );

    expect(projected).not.toHaveProperty("entry");
    expect(projected.name).toBe("n");
    expect(projected.path).toBe("p");
  });
});

describe("the three fields this task was filed for (mt#5011)", () => {
  test("logOnlyFamilySinceLastReview, allSuppressed and allWithheld reach the JSON path", () => {
    const projected = projectCalibrationLogResult(
      stubResult({
        logOnlyFamilySinceLastReview: 3,
        allSuppressed: false,
        allWithheld: true,
      })
    );

    // `toHaveProperty` rather than a value check alone: the defect produced
    // `undefined` on read, and `expect(x.allSuppressed).toBe(false)` would have
    // FAILED for the right reason while `expect(x.foo).toBeFalsy()` would have
    // passed for the wrong one. Presence is the claim.
    expect(projected).toHaveProperty("logOnlyFamilySinceLastReview");
    expect(projected).toHaveProperty("allSuppressed");
    expect(projected).toHaveProperty("allWithheld");

    expect(projected.logOnlyFamilySinceLastReview).toBe(3);
    expect(projected.allSuppressed).toBe(false);
    expect(projected.allWithheld).toBe(true);
  });

  test("a false `allSuppressed` is distinguishable from an absent one", () => {
    // The originating hazard in one assertion: before this change a consumer
    // read `undefined` and could not tell it from `false`. Both are falsy; only
    // one is data.
    const projected = projectCalibrationLogResult(stubResult({ allSuppressed: false }));

    expect(projected.allSuppressed).toBe(false);
    expect(projected.allSuppressed).not.toBeUndefined();
  });
});

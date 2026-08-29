/**
 * The sweep's TEXT rendering (mt#3898 / PR #2884 R1).
 *
 * A separate file from `calibration.test.ts`, which covers the command's
 * behavior rather than its presentation.
 *
 * Why this exists: nothing covered `formatResult` at all, so a property the
 * JSON result carried could be absent from the text with typecheck, lint and
 * the whole suite green. That happened twice — PR #2599 R1 (the `no-records`
 * verdict) and PR #2884 R1 (judged-text recoverability) — each caught by a
 * reviewer reading the diff. These tests make the omission fail instead.
 */
import { describe, test, expect } from "bun:test";
import { formatResult } from "./calibration";
import type {
  CalibrationLogResult,
  JudgedTextRecoverability,
} from "../../../domain/calibration/calibration-sweep";

const JUDGED_TEXT_LABEL = "Judged text:";

function resultWith(
  recoverability: JudgedTextRecoverability,
  capturedRecords: number,
  recordsAssessed: number
): CalibrationLogResult {
  return {
    entry: { name: "bare-entity-ref", path: ".minsky/bare-entity-ref-calibration.jsonl" },
    exists: true,
    totalFires: recordsAssessed,
    watermarkCount: 0,
    firesSinceLastReview: recordsAssessed,
    suppressedSinceLastReview: 0,
    injectedFiresSinceLastReview: recordsAssessed,
    evaluatedOnlySinceLastReview: 0,
    distinctPhrases: 3,
    lowDiversity: false,
    atCountThreshold: false,
    pastThreshold: false,
    newRecords: [],
    classifiability: {
      verdict: "classifiable",
      evidenceFields: ["matches"],
      recordsAssessed,
      // mt#4465: `recoverableRecords` is what the PARTIAL line now bounds the
      // rate to. It equals `capturedRecords` here because these fixtures model
      // a marker-only log — the two diverge exactly when a detector carries
      // judged text under its own key, which `calibration-judged-text.test.ts`
      // covers against parsed records.
      judgedText: {
        recoverability,
        capturedRecords,
        recoverableRecords: capturedRecords,
        recordsAssessed,
      },
    },
  } as unknown as CalibrationLogResult;
}

describe("formatResult — judged-text recoverability", () => {
  test("an unrecoverable log says so, beside a classifiable verdict", () => {
    const text = formatResult([resultWith("unrecoverable", 0, 311)], []);
    // The pair is the point: reporting only the left-hand answer is the gap.
    expect(text).toContain("Classifiable:           yes");
    expect(text).toContain(`${JUDGED_TEXT_LABEL}            GONE`);
    // Names BOTH conditions (PR #3432 R1): the old "carry no capture" wording
    // asserted the marker-absence-is-unrecoverable equivalence that mt#4465
    // removed from the derivation.
    expect(text).toContain("311 record(s) carry neither a capture marker nor readable judged text");
  });

  test("a partial log reports the recoverable count so a rate can be bounded", () => {
    const text = formatResult([resultWith("partial", 133, 375)], []);
    expect(text).toContain(`${JUDGED_TEXT_LABEL}            PARTIAL — 133 of 375`);
  });

  test("a fully captured log reports recoverable", () => {
    const text = formatResult([resultWith("recoverable", 20, 20)], []);
    expect(text).toContain(`${JUDGED_TEXT_LABEL}            recoverable`);
  });

  test("every recoverability state renders — none is silently omitted", () => {
    // The regression shape both R1 findings had: a state the JSON carries and
    // the text drops. Asserting per-state presence catches a dropped BRANCH,
    // which a single happy-path assertion cannot.
    const states: JudgedTextRecoverability[] = [
      "recoverable",
      "partial",
      "unrecoverable",
      "no-records",
    ];
    for (const state of states) {
      const text = formatResult([resultWith(state, 1, 2)], []);
      expect(text).toContain(JUDGED_TEXT_LABEL);
    }
  });
});

describe("formatResult — evaluated-only records (mt#3863)", () => {
  test("the evaluated-only figure renders alongside the injected count", () => {
    const result = resultWith("recoverable", 20, 20);
    result.evaluatedOnlySinceLastReview = 185;
    result.injectedFiresSinceLastReview = 8;
    const text = formatResult([result], []);

    expect(text).toContain("...evaluated-only:    185");
    expect(text).toContain("...injected:          8");
  });

  test("no evaluated-only line when the figure is zero", () => {
    const result = resultWith("recoverable", 20, 20);
    result.evaluatedOnlySinceLastReview = 0;
    result.suppressedSinceLastReview = 0;
    const text = formatResult([result], []);

    expect(text).not.toContain("...evaluated-only:");
  });
});

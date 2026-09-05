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

describe("formatResult — watermark-stranded rendering (mt#4904)", () => {
  test("a stranded log's fires-since-review is marked NOT MEANINGFUL, with both operands", () => {
    // PR #3572 R2. The text surface had the same gap R1 closed in the JSON one:
    // this log printed "Fires since review: 0" — the clamp's output — with
    // nothing distinguishing it from a log that was genuinely just reviewed.
    // The `exists: false` case is the one that matters, because the review-due
    // leg declines it, so this per-log block is the ONLY place it can surface.
    const result = resultWith("recoverable", 0, 0);
    result.exists = false;
    result.totalFires = 0;
    result.firesSinceLastReview = 0;
    result.watermarkCount = 1760;
    result.watermarkStranded = true;

    const text = formatResult([result], []);
    expect(text).toContain("NOT MEANINGFUL");
    expect(text).toContain("1760");
  });

  test("a healthy log's fires-since-review carries no annotation", () => {
    // The inverse guard: annotating every log would make the marker worthless.
    const result = resultWith("recoverable", 20, 20);
    result.watermarkCount = 0;
    result.watermarkStranded = false;

    expect(formatResult([result], [])).not.toContain("NOT MEANINGFUL");
  });

  test("the review-due summary renders the comparison, not the fabricated zero", () => {
    // Sibling of the cadence hook's `legLine` branch. `firesSinceLastReview` is
    // 0 by construction for a stranded log, so the shared summary form read
    // "(0 new / 121 total fires)" about the one log whose new-fire count is
    // known to be meaningless.
    const text = formatResult(
      [],
      [
        {
          name: "untaken-action",
          path: ".minsky/untaken-action-calibration.jsonl",
          kind: "untaken-action",
          firesSinceLastReview: 0,
          injectedFiresSinceLastReview: 0,
          suppressedSinceLastReview: 0,
          logOnlyFamilySinceLastReview: 0,
          totalFires: 121,
          distinctPhrases: 0,
          reason: "watermark-stranded",
          watermarkCount: 424,
        },
      ]
    );

    expect(text).toContain("watermark 424 exceeds 121 record(s)");
    expect(text).not.toContain("0 new / 121 total fires");
  });
});

describe("formatResult — all-suppressed records are printed (mt#4049, PR #3630 R1)", () => {
  /**
   * An all-suppressed log has `atCountThreshold === false` by construction —
   * that flag reads the injected count, which this leg requires to be zero. The
   * producer widened its own gate to `atCountThreshold || allSuppressed`; this
   * renderer was left on `atCountThreshold` alone, so the sweep surfaced the
   * records and the text output silently dropped them. Reviewer-caught.
   */
  function allSuppressedResult(overrides: Partial<CalibrationLogResult> = {}) {
    return {
      entry: {
        name: "knowledge-acquisition",
        path: ".minsky/knowledge-acquisition-calibration.jsonl",
      },
      exists: true,
      totalFires: 15,
      watermarkCount: 0,
      firesSinceLastReview: 15,
      suppressedSinceLastReview: 13,
      injectedFiresSinceLastReview: 0,
      evaluatedOnlySinceLastReview: 0,
      distinctPhrases: 13,
      lowDiversity: false,
      // Both false, as production computes them for this leg — that pairing is
      // the whole point of the regression.
      atCountThreshold: false,
      pastThreshold: false,
      allSuppressed: true,
      newRecords: [
        { timestamp: "2026-09-04T17:31:35.763Z", outcome: "suppressed", reason: "propagation" },
      ],
      classifiability: {
        verdict: "classifiable",
        evidenceFields: ["suppressionReasons"],
        recordsAssessed: 15,
        judgedText: {
          recoverability: "unrecoverable",
          capturedRecords: 0,
          recoverableRecords: 0,
          recordsAssessed: 15,
        },
      },
      ...overrides,
    } as unknown as CalibrationLogResult;
  }

  test("prints the New records block even though atCountThreshold is false", () => {
    const out = formatResult([allSuppressedResult()], []);
    expect(out).toContain("New records (1)");
  });

  test("still withholds records for a below-bar log that is NOT all-suppressed", () => {
    // The negative control on the widening: this is the ordinary
    // below-the-count-bar case, which must stay exactly as quiet as it was.
    const out = formatResult([allSuppressedResult({ allSuppressed: false })], []);
    expect(out).not.toContain("New records (");
  });
});

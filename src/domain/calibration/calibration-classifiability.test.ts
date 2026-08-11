/**
 * The sweep's classifiability verdict (mt#3610).
 *
 * The verdict exists because "can these fires be rated?" was previously answered
 * only by a reviewing agent's eye, and a wrong answer contradicted nothing. On
 * 2026-08-03 a sweep called `wall-of-text` unratable while its `wordCount` and
 * `trigger` sat at the top level of the same output, next to the nested
 * `detectorFields` object quoted as proof of their absence (mem#827).
 *
 * A separate file rather than an addition to `calibration-sweep.test.ts`: that
 * file sits at the 1500-line ESLint ceiling, and mt#3576 shipped a CI failure
 * because two branches each under the limit merged to over it.
 *
 * @see mt#3610
 * @see mt#3576 — the originating misread
 */

import { describe, test, expect } from "bun:test";
import { assessClassifiability, parseCalibrationRecord } from "./calibration-sweep";
import type { CalibrationRecord, ClassifiabilityVerdict } from "./calibration-sweep";

// Named once rather than repeated across assertions (custom/no-magic-string-duplication).
// Typed, so a renamed verdict fails to compile here instead of silently never matching.
const CLASSIFIABLE: ClassifiabilityVerdict = "classifiable";
const NOT_CLASSIFIABLE: ClassifiabilityVerdict = "not-classifiable";
const NO_RECORDS: ClassifiabilityVerdict = "no-records";

/** A real wall-of-text line, verbatim from the production log. */
const REAL_WALL_OF_TEXT_LINE = JSON.stringify({
  timestamp: "2026-08-01T20:09:14.456Z",
  session_id: "1623b105-b28d-4dc4-a413-3ca88ddda1de",
  wordCount: 444,
  lineCount: 30,
  trigger: "over-budget",
  leadLabelHits: [],
  deeplinkCount: 1,
  namedRefCount: 23,
  textHash: "e59380be7d11bc36",
  suppressedByDepthRequest: false,
});

describe("assessClassifiability (mt#3610)", () => {
  test("the wall-of-text records the 2026-08-03 sweep called unratable are CLASSIFIABLE", () => {
    // The acceptance bar: the verdict must contradict the disposition that was
    // actually filed. If this ever returns not-classifiable, the incident that
    // produced mt#3576 could recur unchallenged.
    const record = parseCalibrationRecord(REAL_WALL_OF_TEXT_LINE, "wall-of-text");
    expect(record).not.toBeNull();
    const assessment = assessClassifiability([record as CalibrationRecord]);
    expect(assessment.verdict).toBe(CLASSIFIABLE);
    expect(assessment.recordsAssessed).toBe(1);
    expect(assessment.evidenceFields).toContain("wordCount");
    expect(assessment.evidenceFields).toContain("trigger");
  });

  test("a passthrough field is reported WITH its level, never bare", () => {
    // The level is the substance: flattening `detectorFields.textHash` to
    // `textHash` would answer the question while hiding the two-level structure
    // whose conflation caused the incident.
    const record = parseCalibrationRecord(REAL_WALL_OF_TEXT_LINE, "wall-of-text");
    const { evidenceFields } = assessClassifiability([record as CalibrationRecord]);
    expect(evidenceFields).toContain("detectorFields.textHash");
    expect(evidenceFields).not.toContain("textHash");
  });

  test("records carrying only shared bookkeeping are NOT classifiable", () => {
    const bare = [
      { timestamp: "2026-08-01T00:00:00Z", session_id: "s1", suppressionReasons: [] },
      { timestamp: "2026-08-01T00:01:00Z", session_id: "s2" },
    ] as unknown as CalibrationRecord[];
    const assessment = assessClassifiability(bare);
    expect(assessment.verdict).toBe(NOT_CLASSIFIABLE);
    expect(assessment.evidenceFields).toEqual([]);
    expect(assessment.recordsAssessed).toBe(2);
  });

  test("an empty log is 'no-records', a distinct verdict from not-classifiable", () => {
    // mt#3502's lesson: "nothing has fired" and "the fires cannot be reviewed"
    // demand opposite responses, so they must not collapse into one boolean.
    const assessment = assessClassifiability([]);
    expect(assessment.verdict).toBe(NO_RECORDS);
    expect(assessment.recordsAssessed).toBe(0);
  });

  test("a key the parser set to undefined does not count as evidence", () => {
    // The per-kind branches set every declared key, including ones the raw line
    // lacked. Counting those would report a record classifiable on fields that
    // carry nothing — the exact false-confidence this verdict exists to prevent.
    const record = parseCalibrationRecord(
      JSON.stringify({
        timestamp: "2026-08-01T00:00:00Z",
        session_id: "s1",
        wordCount: 500,
        trigger: "over-budget",
      }),
      "wall-of-text"
    ) as unknown as Record<string, unknown>;
    // The branch declares `excerpt`/`leadLabelHits` but the line carried neither.
    expect("excerpt" in record).toBe(true);
    expect(record["excerpt"]).toBeUndefined();
    const { evidenceFields } = assessClassifiability([record as unknown as CalibrationRecord]);
    expect(evidenceFields).not.toContain("excerpt");
    expect(evidenceFields).toContain("wordCount");
  });

  // PR #2599 R1 regression: a key being SET is not the same as it holding
  // evidence. Pre-fix, a record whose only non-shared fields were an empty
  // array and an empty string returned `classifiable` and listed both — a
  // false verdict in the permissive direction, which is the one that would tell
  // a reviewer the fires are ratable when they are not.
  test("empty collections and empty strings are not evidence", () => {
    const vacuous = [
      { timestamp: "t", session_id: "s", leadLabelHits: [], excerpt: "", extras: {} },
    ] as unknown as CalibrationRecord[];
    const assessment = assessClassifiability(vacuous);
    expect(assessment.verdict).toBe(NOT_CLASSIFIABLE);
    expect(assessment.evidenceFields).toEqual([]);
  });

  // The other half of the same rule: a zero or a false is a MEASURED value, not
  // an absent one. Dropping these would under-report evidence and could make a
  // genuinely-ratable log look unratable.
  test("0 and false ARE evidence — they are measurements, not emptiness", () => {
    const measured = [
      { timestamp: "t", session_id: "s", deeplinkCount: 0, hadSameTurnRead: false },
    ] as unknown as CalibrationRecord[];
    const assessment = assessClassifiability(measured);
    expect(assessment.verdict).toBe(CLASSIFIABLE);
    expect(assessment.evidenceFields).toEqual(["deeplinkCount", "hadSameTurnRead"]);
  });

  test("a vacuous passthrough value is not evidence either", () => {
    const record = [
      { timestamp: "t", session_id: "s", detectorFields: { note: "", tags: [] } },
    ] as unknown as CalibrationRecord[];
    expect(assessClassifiability(record).verdict).toBe(NOT_CLASSIFIABLE);
  });

  test("evidence is unioned across records and sorted", () => {
    const records = [
      { timestamp: "t1", session_id: "s", wordCount: 500 },
      { timestamp: "t2", session_id: "s", trigger: "over-budget" },
    ] as unknown as CalibrationRecord[];
    const { evidenceFields, verdict } = assessClassifiability(records);
    expect(verdict).toBe(CLASSIFIABLE);
    expect(evidenceFields).toEqual(["trigger", "wordCount"]);
  });
});

// ---------------------------------------------------------------------------
// Judged-text recoverability (mt#3898)
// ---------------------------------------------------------------------------

/**
 * A `bare-entity-ref` line, verbatim from the production log — the surface whose
 * un-auditability (mem#623 R7) is why this property exists. It is `classifiable`
 * on `matches` and carries no capture at all.
 */
const FIXTURE_SESSION_ID = "af417af8-816e-48a6-a511-8c2ee0f3b212";

const REAL_BARE_ENTITY_REF_LINE = JSON.stringify({
  source: "live",
  channel: "stop",
  timestamp: "2026-08-10T01:21:02.432Z",
  session_id: FIXTURE_SESSION_ID,
  stop_hook_active: true,
  matches: [{ family: "bare-ref", phrase: "mt#3851" }],
  logged_only: [],
  flagged_count: 1,
  logged_only_count: 0,
});

/** The same shape once the writer adopts mt#3607's marker. */
const CAPTURED_LINE = JSON.stringify({
  source: "live",
  channel: "stop",
  timestamp: "2026-08-10T01:21:02.432Z",
  session_id: FIXTURE_SESSION_ID,
  captureSchema: 1,
  matches: [{ family: "bare-ref", phrase: "mt#3851", context: "shipped in mt#3851 today" }],
});

/**
 * Parse a fixture line, failing the test loudly if the parser rejects it rather
 * than silently asserting against a null.
 */
const parse = (line: string): CalibrationRecord => {
  const record = parseCalibrationRecord(line, "bare-entity-ref");
  if (!record) throw new Error(`fixture line did not parse: ${line}`);
  return record;
};

describe("judged-text recoverability", () => {
  test("an uncaptured log is unrecoverable while still being classifiable", () => {
    const result = assessClassifiability([parse(REAL_BARE_ENTITY_REF_LINE)]);

    // Both properties are reported, and they disagree — which is the whole
    // point. Before mt#3898 a reviewer saw only the left-hand answer.
    expect(result.verdict).toBe(CLASSIFIABLE);
    expect(result.judgedText.recoverability).toBe("unrecoverable");
    expect(result.judgedText.capturedRecords).toBe(0);
  });

  test("a captured log reports recoverable", () => {
    const result = assessClassifiability([parse(CAPTURED_LINE)]);
    expect(result.judgedText.recoverability).toBe("recoverable");
    expect(result.judgedText.capturedRecords).toBe(1);
  });

  test("mid-adoption reports partial rather than rounding to either end", () => {
    const result = assessClassifiability([
      parse(CAPTURED_LINE),
      parse(REAL_BARE_ENTITY_REF_LINE),
      parse(REAL_BARE_ENTITY_REF_LINE),
    ]);
    expect(result.judgedText.recoverability).toBe("partial");
    expect(result.judgedText.capturedRecords).toBe(1);
    expect(result.judgedText.recordsAssessed).toBe(3);
  });

  test("the marker is found on the detectorFields passthrough, not just the top level", () => {
    // For most logs the marker arrives here rather than at the top level, since
    // `parseDetectorFields` routes any key no per-kind branch names into the
    // passthrough. Reading one level only reports captured logs as unrecoverable.
    const record = parse(REAL_BARE_ENTITY_REF_LINE);
    const withPassthroughMarker: CalibrationRecord = {
      ...record,
      detectorFields: { ...(record.detectorFields ?? {}), captureSchema: 1 },
    };
    expect(assessClassifiability([withPassthroughMarker]).judgedText.recoverability).toBe(
      "recoverable"
    );
  });

  test("a different log kind also routes the marker through the passthrough", () => {
    // Not a second level — a second KIND. `captureSchema` is named by no
    // per-kind parse branch, so it reaches `detectorFields` for every log,
    // including the execution-evidence surfaces whose records carry it at the
    // top level in the RAW jsonl. A staged negative control established this:
    // disabling a top-level read left every test green, including one written
    // specifically to exercise it, which is why that branch no longer exists.
    // This test pins the actual behavior across kinds so a future per-kind
    // branch that hoists the marker breaks here rather than silently.
    const executionEvidenceLine = JSON.stringify({
      timestamp: "2026-08-08T05:30:22.076Z",
      task: "mt#3898",
      prNumber: 2599,
      surface: "execution-evidence-at-coverage",
      captureSchema: 1,
      judgedPrBody: "Execution evidence: 15 pass 0 fail",
    });
    const record = parseCalibrationRecord(executionEvidenceLine, "execution-evidence-at-coverage");
    if (!record) throw new Error("fixture line did not parse");
    expect(assessClassifiability([record]).judgedText.recoverability).toBe("recoverable");
  });

  test("an empty log reports no-records on both properties, not unrecoverable", () => {
    const result = assessClassifiability([]);
    expect(result.verdict).toBe(NO_RECORDS);
    expect(result.judgedText.recoverability).toBe("no-records");
  });

  test("the marker alone never makes a log classifiable", () => {
    // It is bookkeeping on both axes: it says capture HAPPENED, and is not
    // itself something to judge a fire by.
    const markerOnly = JSON.stringify({
      timestamp: "2026-08-10T01:21:02.432Z",
      session_id: FIXTURE_SESSION_ID,
      captureSchema: 1,
    });
    const result = assessClassifiability([parse(markerOnly)]);
    expect(result.verdict).toBe(NOT_CLASSIFIABLE);
    expect(result.judgedText.recoverability).toBe("recoverable");
  });
});

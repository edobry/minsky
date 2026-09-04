/**
 * Judged-text recoverability, derived from the evidence a record ACTUALLY
 * carries rather than from the capture marker alone (mt#4465).
 *
 * Every record below is PARSED from a JSONL line via `parseCalibrationRecord`,
 * never hand-built. That is mem#888's rule 2 and it is load-bearing here: a key
 * no per-kind branch names rides into `detectorFields`, so a hand-built
 * top-level object skips the very placement this derivation has to handle. The
 * four fixtures are deliberately split across both levels —
 * `final_message_tail` and `claims` reach the passthrough, `excerpt` and
 * `transcript_excerpt` are consumed at the top level — so a one-level
 * implementation passes some of these and fails others.
 *
 * A separate file rather than an addition to `calibration-classifiability.test.ts`
 * for the reason that file's own header gives: `calibration-sweep.test.ts` sits
 * at the ESLint line ceiling and mt#3576 shipped a CI failure when two branches
 * each under the limit merged to over it.
 *
 * @see mt#4465 — this task
 * @see mem#888 — the two-level placement rule these fixtures exercise
 * @see mt#3607 — the capture marker, still reported as `capturedRecords`
 */

import { describe, test, expect } from "bun:test";
import { assessClassifiability, parseCalibrationRecord } from "./calibration-sweep";
import type { CalibrationRecord, CalibrationLogEntry } from "./calibration-sweep";

/** Parse one line the way the sweep does, failing loudly rather than returning null. */
function parsed(line: string, kind: CalibrationLogEntry["kind"]): CalibrationRecord {
  const record = parseCalibrationRecord(line, kind);
  if (!record) throw new Error(`fixture failed to parse for kind ${kind}`);
  return record;
}

const SESSION_ID = "f15c85f9-b245-433d-b7b0-e8019344415b";

/** A detector name deliberately absent from `JUDGED_TEXT_FIELDS`. */
const UNMAPPED = "some-new-detector";

/**
 * `untaken-action`, verbatim key set from the production log (2026-08-29).
 * `final_message_tail` is named by NO per-kind branch, so it reaches
 * `detectorFields` — the passthrough half of the two-level split.
 */
function untakenActionLine(tail: string): string {
  return JSON.stringify({
    timestamp: "2026-08-28T22:14:03.101Z",
    session_id: SESSION_ID,
    channel: "stop",
    source: "turn-end-untaken-action-scan",
    stop_hook_active: false,
    matches: [{ family: "ill-action", phrase: "I'll implement it" }],
    final_message_tail: tail,
  });
}

/** `wall-of-text`, whose `excerpt` IS consumed at the top level. */
function wallOfTextLine(excerpt: string): string {
  return JSON.stringify({
    timestamp: "2026-08-28T22:14:03.101Z",
    session_id: SESSION_ID,
    wordCount: 444,
    lineCount: 30,
    trigger: "over-budget",
    leadLabelHits: [],
    deeplinkCount: 1,
    namedRefCount: 23,
    excerpt,
  });
}

/** `negative-existence-claim`, whose judged text sits inside `claims[].excerpt`. */
function negativeExistenceLine(excerpts: string[]): string {
  return JSON.stringify({
    timestamp: "2026-08-28T22:14:03.101Z",
    session_id: SESSION_ID,
    doneTaskIds: ["mt#4197"],
    doneLookupUnavailable: false,
    thinSearches: 1,
    claims: excerpts.map((excerpt) => ({ pattern: "no such", excerpt })),
  });
}

const REAL_TAIL =
  "I'll implement the fix in a follow-up once the current PR merges, so nothing is blocked here.";

describe("judged-text recoverability derives from the evidence present (mt#4465)", () => {
  test("AT1: final_message_tail with no captureSchema is RECOVERABLE, not unrecoverable", () => {
    const records = [parsed(untakenActionLine(REAL_TAIL), "untaken-action")];

    const { judgedText } = assessClassifiability(records, "untaken-action");

    expect(judgedText.recoverability).toBe("recoverable");
    expect(judgedText.recoverableRecords).toBe(1);
    // The adoption signal is untouched and still reports non-adoption.
    expect(judgedText.capturedRecords).toBe(0);
    expect(judgedText.unmappedDetector).toBeUndefined();
  });

  test("a top-level field (wall-of-text's `excerpt`) is found too — both levels are read", () => {
    const records = [parsed(wallOfTextLine("A long report the detector judged."), "wall-of-text")];

    const { judgedText } = assessClassifiability(records, "wall-of-text");

    expect(judgedText.recoverability).toBe("recoverable");
    expect(judgedText.capturedRecords).toBe(0);
  });

  test("judged text nested in an array of objects (`claims[].excerpt`) counts", () => {
    const records = [
      parsed(negativeExistenceLine(["nothing in the corpus covers this"]), "generic-matches"),
    ];

    const { judgedText } = assessClassifiability(records, "negative-existence-claim");

    expect(judgedText.recoverability).toBe("recoverable");
    expect(judgedText.recoverableRecords).toBe(1);
  });

  test("a mixed log reports PARTIAL, bounded to the recoverable records", () => {
    const records = [
      parsed(untakenActionLine(REAL_TAIL), "untaken-action"),
      parsed(untakenActionLine(""), "untaken-action"),
    ];

    const { judgedText } = assessClassifiability(records, "untaken-action");

    expect(judgedText.recoverability).toBe("partial");
    expect(judgedText.recoverableRecords).toBe(1);
    expect(judgedText.recordsAssessed).toBe(2);
  });
});

describe("the mt#3607 bar is not weakened (mt#4465 SC3)", () => {
  test("AT2 negative control: neither a marker nor mapped judged text is still UNRECOVERABLE", () => {
    // Same detector, same mapping — only the evidence is absent. If this passed,
    // the derivation would be reporting recoverable for text nobody can read,
    // which is the permissive direction the whole mechanism exists to prevent.
    const records = [parsed(untakenActionLine(""), "untaken-action")];

    const { judgedText } = assessClassifiability(records, "untaken-action");

    expect(judgedText.recoverability).toBe("unrecoverable");
    expect(judgedText.recoverableRecords).toBe(0);
    // Mapped, so this is a real "the text is gone" — not a missing-map gap.
    expect(judgedText.unmappedDetector).toBeUndefined();
  });

  test("an array of objects whose strings are all empty does NOT count as judged text", () => {
    const records = [parsed(negativeExistenceLine(["", ""]), "generic-matches")];

    const { judgedText } = assessClassifiability(records, "negative-existence-claim");

    expect(judgedText.recoverability).toBe("unrecoverable");
    expect(judgedText.recoverableRecords).toBe(0);
  });
});

describe("an unmapped detector is NAMED, not silently zero (mt#4465 SC4)", () => {
  test("AT3: an unmapped log reports unrecoverable AND names itself", () => {
    const records = [parsed(untakenActionLine(REAL_TAIL), "untaken-action")];

    const { judgedText } = assessClassifiability(records, UNMAPPED);

    expect(judgedText.recoverability).toBe("unrecoverable");
    expect(judgedText.unmappedDetector).toBe(UNMAPPED);
  });

  test("a marker-carrying log needs no mapping, so it is not reported as a gap", () => {
    // `captureSchema` is named by no per-kind branch, so it reaches
    // `detectorFields` — which is exactly where `hasCaptureMarker` reads it.
    const withMarker = JSON.stringify({
      timestamp: "2026-08-28T22:14:03.101Z",
      session_id: SESSION_ID,
      matches: [{ family: "x", phrase: "y" }],
      captureSchema: 1,
    });
    const records = [parsed(withMarker, "generic-matches")];

    const { judgedText } = assessClassifiability(records, UNMAPPED);

    expect(judgedText.recoverability).toBe("recoverable");
    expect(judgedText.capturedRecords).toBe(1);
    expect(judgedText.unmappedDetector).toBeUndefined();
  });

  test("no records is still `no-records`, never an unmapped-detector gap", () => {
    const { judgedText } = assessClassifiability([], UNMAPPED);

    expect(judgedText.recoverability).toBe("no-records");
    expect(judgedText.unmappedDetector).toBeUndefined();
  });
});

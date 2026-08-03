/**
 * `wall-of-text` record parsing in the calibration sweep (mt#3576).
 *
 * Split out of `calibration-sweep.test.ts`, which sits at the 1500-line ESLint
 * ceiling: that file counted 1512 lines once this task's additions merged with
 * concurrent ones from main, so CI failed on the MERGE result while each branch
 * passed alone. A per-record-kind sibling is where this coverage grows.
 *
 * Covers:
 * - `excerpt` is lifted to a TOP-LEVEL typed field, not left in the
 *   `detectorFields` passthrough. That placement is the substance of mt#3576,
 *   not a detail: the incident that filed the task was a calibration reviewer
 *   quoting the nested passthrough object as though it were the whole record,
 *   and reporting the measurements one level up as missing.
 * - A record written before the field shipped still parses, with `excerpt`
 *   undefined — absent means "predates the field," never "empty report."
 *
 * @see mt#3576
 * @see mt#3289 — the `detectorFields` passthrough these assert against
 */

import { describe, test, expect } from "bun:test";
import { parseCalibrationRecord } from "./calibration-sweep";

/** Fields every wall-of-text record has carried since the detector shipped (mt#2870). */
const BASE_RECORD = {
  timestamp: "2026-07-17T12:00:00Z",
  session_id: "wall-session",
  wordCount: 912,
  lineCount: 41,
  trigger: "lead-labels",
  leadLabelHits: ["gate-letter"],
  deeplinkCount: 0,
  namedRefCount: 7,
  textHash: "abc123",
};

const EXCERPT_TEXT = "Gate (l) blocked promotion. w0 w1 w2";

describe("parseCalibrationRecord — wall-of-text excerpt (mt#3576)", () => {
  test("an excerpt parses as a top-level field, not into detectorFields", () => {
    const record = parseCalibrationRecord(
      JSON.stringify({ ...BASE_RECORD, excerpt: EXCERPT_TEXT }),
      "wall-of-text"
    );
    expect(record).not.toBeNull();
    if (!record || !("wordCount" in record)) throw new Error("expected a WallOfTextRecord");
    expect(record.excerpt).toBe(EXCERPT_TEXT);
    // `textHash` is genuinely unconsumed and still rides the passthrough — so
    // this is not passing merely because detectorFields is empty.
    expect(record.detectorFields?.["textHash"]).toBe("abc123");
    expect(record.detectorFields?.["excerpt"]).toBeUndefined();
  });

  // A verbatim record from the live log, written before the field existed.
  test("a pre-excerpt record still parses, with excerpt undefined", () => {
    const record = parseCalibrationRecord(
      JSON.stringify({
        timestamp: "2026-07-18T00:20:09.120Z",
        session_id: "wall-session",
        wordCount: 444,
        lineCount: 30,
        trigger: "over-budget",
        leadLabelHits: [],
        deeplinkCount: 1,
        namedRefCount: 23,
        textHash: "e59380be7d11bc36",
        suppressedByDepthRequest: false,
      }),
      "wall-of-text"
    );
    expect(record).not.toBeNull();
    if (!record || !("wordCount" in record)) throw new Error("expected a WallOfTextRecord");
    expect(record.wordCount).toBe(444);
    expect(record.excerpt).toBeUndefined();
    expect(record.detectorFields?.["textHash"]).toBe("e59380be7d11bc36");
  });
});

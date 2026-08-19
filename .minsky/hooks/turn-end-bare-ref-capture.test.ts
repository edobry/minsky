// mt#4161: the judged-message capture this guard's records now carry.
//
// The assertion that matters is NOT "the field is set" — it is "the SWEEP can
// see it". Those come apart, and that is the whole defect class this file
// exists for: `captureSchema` is named by no per-kind parse branch, so
// `parseDetectorFields` routes it into the nested `detectorFields` object, and
// `hasCaptureMarker` reads it from there and nowhere else. A test that asserts
// on a hand-built top-level object passes while the sweep still reports
// `unrecoverable` (mem#888, the mt#3607 instance the reviewer caught on
// PR #2679).
//
// So every assertion below goes through the REAL parse path —
// `parseCalibrationLines` on a JSONL line, under this log's own registered
// `kind` ("bare-entity-ref") — rather than a constructed record.
//
// Known limit, stated rather than papered over: the fixture is built the way
// `run()` builds its calibration object, not BY `run()` (driving it needs a
// transcript, a session id and a short-id map). So this pins the record SHAPE
// against the sweep; it does not pin `run()` against the shape. The
// `captureSchema`/`captureArtifact` values come from the same module `run()`
// imports, so a version bump cannot silently split the two.

import { describe, expect, it } from "bun:test";
import { CAPTURE_SCHEMA_VERSION, captureArtifact } from "./judged-input-capture";
import {
  assessClassifiability,
  parseCalibrationLines,
} from "../../src/domain/calibration/calibration-sweep";

/** A message carrying a bare short id — the class this detector flags. */
const JUDGED_MESSAGE =
  "Recorded the finding in mem#1041 after re-reading the spec. " +
  "The UUID was in hand the whole time: minsky://memory/d8891fad-b156-46e1-8940-98067eb097a9. " +
  "Filed the follow-up as mt#4161.";

/**
 * One record in the exact shape `run()` emits, as a JSONL line.
 *
 * `judgedMessage` and `captureSchema` are produced by the same calls `run()`
 * makes, so the two cannot drift on value or version.
 */
function parseOne(line: string) {
  const records = parseCalibrationLines(line, "bare-entity-ref");
  expect(records).toHaveLength(1);
  return records[0] as { detectorFields?: Record<string, unknown> };
}

function recordLine(message: string): string {
  return JSON.stringify({
    source: "live",
    channel: "stop",
    timestamp: "2026-08-19T02:00:00.000Z",
    session_id: "session-under-test",
    stop_hook_active: false,
    matches: [{ family: "bare-short-id", phrase: "mem#1041" }],
    logged_only: [],
    author_linked: [],
    flagged_count: 1,
    logged_only_count: 0,
    author_linked_count: 0,
    advisory_chain_capped: false,
    advisory_emitted: true,
    captureSchema: CAPTURE_SCHEMA_VERSION,
    judgedMessage: captureArtifact(message),
  });
}

describe("bare-entity-ref judged-message capture (mt#4161)", () => {
  it("AT1: the sweep reports the log as recoverable, not unrecoverable", () => {
    const records = parseCalibrationLines(recordLine(JUDGED_MESSAGE), "bare-entity-ref");
    expect(records).toHaveLength(1);

    const assessment = assessClassifiability(records);
    expect(assessment.judgedText.recoverability).toBe("recoverable");
    expect(assessment.judgedText.capturedRecords).toBe(1);
    expect(assessment.judgedText.recordsAssessed).toBe(1);
  });

  it("AT1 discriminates: the same record WITHOUT the marker is unrecoverable", () => {
    // Without this, the assertion above would pass on any record at all and
    // would not be evidence that the marker is what produced the verdict
    // (mem#1020 — an inert fixture is green in the negative direction).
    const withoutMarker = JSON.parse(recordLine(JUDGED_MESSAGE)) as Record<string, unknown>;
    delete withoutMarker["captureSchema"];

    const records = parseCalibrationLines(JSON.stringify(withoutMarker), "bare-entity-ref");
    const assessment = assessClassifiability(records);
    expect(assessment.judgedText.recoverability).toBe("unrecoverable");
    expect(assessment.judgedText.capturedRecords).toBe(0);
  });

  it("the marker survives parsing as a NUMBER, in detectorFields", () => {
    // `hasCaptureMarker` requires BOTH: the passthrough level, and a numeric
    // value. A string "1" parses fine and reads as uncaptured.
    const passthrough = parseOne(recordLine(JUDGED_MESSAGE)).detectorFields;
    expect(typeof passthrough?.["captureSchema"]).toBe("number");
  });

  it("AT2: the flagged ref can be located within the captured message", () => {
    const passthrough = parseOne(recordLine(JUDGED_MESSAGE)).detectorFields;
    const captured = passthrough?.["judgedMessage"] as { excerpt: string; truncated: boolean };

    // The point of the capture: a rater holding only `matches` sees the ref was
    // flagged; holding the message they can decide whether it should have been.
    expect(captured.excerpt).toContain("mem#1041");
    expect(captured.truncated).toBe(false);
  });

  it("the capture answers the questions a per-match window could not", () => {
    // Why the WHOLE message rather than `extractMatchContext`'s 240-char
    // window: two of the three rating questions are about the message as a
    // whole, and a window around `mem#1041` contains neither answer.
    const passthrough = parseOne(recordLine(JUDGED_MESSAGE)).detectorFields;
    const excerpt = (passthrough?.["judgedMessage"] as { excerpt: string }).excerpt;

    // "was a UUID actually in hand?" — the deeplink sits in a later sentence.
    expect(excerpt).toContain("minsky://memory/d8891fad-b156-46e1-8940-98067eb097a9");
    // "was this the first mention?" — needs everything before the match too.
    expect(excerpt.indexOf("mem#1041")).toBeGreaterThan(0);
  });

  it("a message past the cap is recorded as truncated rather than silently cut", () => {
    // A rater reading a truncated record must report partial, never a verdict
    // (mem#704). That is only possible if truncation is recorded.
    const huge = `${"x".repeat(20_000)} mem#1041`;
    const passthrough = parseOne(recordLine(huge)).detectorFields;
    const captured = passthrough?.["judgedMessage"] as { truncated: boolean; length: number };

    expect(captured.truncated).toBe(true);
    expect(captured.length).toBe(huge.length);
  });
});

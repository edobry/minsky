/**
 * Replay-harness acceptance tests (mt#3649) — AT2 through AT5.
 *
 * These drive the pure comparison function directly rather than the file-reading
 * shell, so no fixture log has to be written to disk.
 */
import { describe, expect, test } from "bun:test";
import { claimKeys, compareRecord, parseLog, summarize } from "./replay-code-mechanism-calibration";
import {
  ARTIFACT_CAPTURE_MAX_CHARS,
  CAPTURE_SCHEMA_FIELD,
  CAPTURE_SCHEMA_VERSION,
  captureArtifact,
} from "../.minsky/hooks/judged-input-capture";
import { detectCodeMechanismAssertion } from "../.minsky/hooks/code-mechanism-assertion-detector";

/** Prose the current detector genuinely extracts a claim from. */
const JUDGED_TEXT = "The 1MB default `maxBuffer` is at its limit, and `executeCommand` clamps it.";

/** A record shaped exactly as the detector now writes one. */
function recordFor(text: string, maxChars?: number): Record<string, unknown> {
  return {
    timestamp: "2026-08-12T00:00:00.000Z",
    session_id: "s-1",
    claims: detectCodeMechanismAssertion(text, "", "").claims,
    [CAPTURE_SCHEMA_FIELD]: CAPTURE_SCHEMA_VERSION,
    judgedInput: captureArtifact(text, maxChars),
  };
}

describe("replay harness (mt#3649)", () => {
  test("the fixture text really does produce claims (guards the tests below)", () => {
    // Without this, an AT2 'same' verdict could be two empty sets agreeing.
    expect(
      claimKeys(detectCodeMechanismAssertion(JUDGED_TEXT, "", "").claims).length
    ).toBeGreaterThan(0);
  });

  test("AT2: a record replayed against the current detector reports 'same'", () => {
    const result = compareRecord(recordFor(JUDGED_TEXT), 0);
    expect(result.verdict).toBe("same");
    expect(result.replayedClaims).toEqual(result.recordedClaims);
    expect(result.replayedClaims.length).toBeGreaterThan(0);
  });

  test("AT3 negative control: a record whose recorded claims differ reports 'changed'", () => {
    // Stands in for perturbing the detector itself: the comparison axis is
    // recorded-vs-replayed, so a recorded set the current detector would not
    // produce is exactly what a changed detector looks like from the harness's
    // side. If this returned 'same', the harness could not detect ANY drift.
    const record = recordFor(JUDGED_TEXT);
    record["claims"] = [{ symbol: "somethingElse", predicate: "does a different thing" }];
    const result = compareRecord(record, 0);
    expect(result.verdict).toBe("changed");
    expect(result.replayedClaims).not.toEqual(result.recordedClaims);
  });

  test("AT4: capture is truncated at the documented cap, and replay reports 'partial'", () => {
    const long = `${JUDGED_TEXT} ${"padding ".repeat(200)}`;
    const cap = 64;
    const record = recordFor(long, cap);
    const captured = record["judgedInput"] as { excerpt: string; truncated: boolean };

    expect(captured.truncated).toBe(true);
    // safeTruncate appends an ellipsis, so the excerpt is bounded by the cap
    // rather than exactly equal to it.
    expect(captured.excerpt.length).toBeLessThanOrEqual(cap + 1);

    // A prefix can only LOSE claims, never gain them, so 'changed' would be
    // uninformative here — the harness must not issue a verdict it cannot back.
    expect(compareRecord(record, 0).verdict).toBe("partial");
  });

  test("the default cap is the shared documented one", () => {
    expect(ARTIFACT_CAPTURE_MAX_CHARS).toBe(16_000);
    const captured = captureArtifact(JUDGED_TEXT);
    expect(captured.truncated).toBe(false);
  });

  test("AT5: a record with no capture reports 'unrecoverable', never 'same'", () => {
    // The mem#704 discipline: a replay that returns the pass answer when its
    // input is missing carries no information. This is the exact shape of the
    // 727 pre-capture records in the live log.
    const preCapture: Record<string, unknown> = {
      timestamp: "2026-08-01T00:00:00.000Z",
      session_id: "s-0",
      claims: [{ symbol: "maxBuffer", predicate: "is at its limit" }],
    };
    const result = compareRecord(preCapture, 0);
    expect(result.verdict).toBe("unrecoverable");
    expect(result.verdict).not.toBe("same");
    expect(result.replayedClaims).toEqual([]);
  });

  test("AT5: a record whose capture is present but malformed is also 'unrecoverable'", () => {
    const record = recordFor(JUDGED_TEXT);
    record["judgedInput"] = { hash: "abc", length: 5 }; // no excerpt
    expect(compareRecord(record, 0).verdict).toBe("unrecoverable");
  });

  test("unrecoverable records are excluded from same/changed in the summary", () => {
    const comparisons = [
      compareRecord(recordFor(JUDGED_TEXT), 0),
      compareRecord({ timestamp: "t", claims: [] }, 1),
    ];
    const summary = summarize(comparisons);
    expect(summary.total).toBe(2);
    expect(summary.same).toBe(1);
    expect(summary.unrecoverable).toBe(1);
    expect(summary.changed).toBe(0);
  });

  test("parseLog skips a partially-written trailing line rather than throwing", () => {
    const text = `${JSON.stringify({ a: 1 })}\n{"b":`;
    expect(parseLog(text)).toEqual([{ a: 1 }]);
  });
});

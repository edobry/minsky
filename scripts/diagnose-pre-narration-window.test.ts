/**
 * Tests for the corpus-normalization half of the pre-narration diagnostic (mt#4256).
 *
 * What is under test is a MEASUREMENT instrument, so the failure that matters is
 * a silently wrong number rather than a thrown error. Both functions here have
 * exactly that failure mode: `locateJudgedTurnEnd` returning the wrong turn
 * yields a confident classification of text nobody judged, and
 * `replayCurrentDetector` collapsing "I could not reconstruct this" into "a fix
 * already retired it" turns a limitation of the script into apparent progress by
 * the detector.
 *
 * Fixture discipline (mem#1020): every claim string below is copied VERBATIM
 * from a real record in `.minsky/pre-narration-calibration.jsonl`, and each
 * negative assertion is preceded by a positive one proving the fixture reaches
 * the matcher at all. An inert fixture passes a `toBe("suppressed")` assertion
 * for the wrong reason and survives its own negative control.
 */
import { describe, expect, test } from "bun:test";
import { locateJudgedTurnEnd, replayCurrentDetector } from "./diagnose-pre-narration-window";
import { detectPreNarrationWithSuppression } from "../.minsky/hooks/pre-narration-detector";
import type { TranscriptLine } from "../.minsky/hooks/transcript";

// Verbatim from the 2026-08-17T18:16:00.829Z record.
const OWN_MERGE_CLAIM = "**Shipped.** PR #3073 merged as abc1234; mt#4212 is DONE.";
// Verbatim from the 2026-08-13T21:17:37.821Z record.
const APPROVED_CLAIM = "APPROVED, 0 blocking (1 non-blocking nit).";

function userLine(ts: string): TranscriptLine {
  return {
    type: "user",
    timestamp: ts,
    message: { role: "user", content: "go on" },
  } as unknown as TranscriptLine;
}

function assistantLine(text: string, ts: string): TranscriptLine {
  return {
    type: "assistant",
    timestamp: ts,
    message: { role: "assistant", content: [{ type: "text", text }] },
  } as unknown as TranscriptLine;
}

function toolLine(name: string, ts: string): TranscriptLine {
  return {
    type: "assistant",
    timestamp: ts,
    message: { role: "assistant", content: [{ type: "tool_use", name, input: {} }] },
  } as unknown as TranscriptLine;
}

describe("locateJudgedTurnEnd — the judged turn is found by content, not by clock", () => {
  test("returns the prompt that CLOSES the turn carrying the phrase", () => {
    const lines = [
      userLine("2026-08-17T18:00:00.000Z"),
      assistantLine("nothing claimed here", "2026-08-17T18:01:00.000Z"),
      userLine("2026-08-17T18:02:00.000Z"),
      assistantLine(OWN_MERGE_CLAIM, "2026-08-17T18:03:00.000Z"),
      userLine("2026-08-17T18:04:00.000Z"),
    ];
    expect(locateJudgedTurnEnd(lines, "2026-08-17T18:03:30.000Z", "PR #3073 merged")).toBe(4);
  });

  test("finds the turn even when the record's timestamp precedes the closing prompt", () => {
    // The defect this replaces: a timestamp-anchored lookup takes the last line
    // at-or-before the record instant, which here is the assistant line — and
    // `extractLastAssistantTurn` then needs two bounding prompts and resolves
    // the PREVIOUS turn. Measured over the real window, timestamp anchoring
    // reconstructed 20 of 30 judged turns; content anchoring reconstructed 30.
    const lines = [
      userLine("2026-08-17T18:00:00.000Z"),
      assistantLine("an earlier, unrelated turn", "2026-08-17T18:01:00.000Z"),
      userLine("2026-08-17T18:02:00.000Z"),
      assistantLine(OWN_MERGE_CLAIM, "2026-08-17T18:03:00.000Z"),
      // Closing prompt lands AFTER the calibration record was written.
      userLine("2026-08-17T18:09:00.000Z"),
    ];
    const end = locateJudgedTurnEnd(lines, "2026-08-17T18:03:10.000Z", "PR #3073 merged");
    expect(end).toBe(4);
  });

  test("a phrase the agent repeats resolves to the occurrence the record is about", () => {
    const lines = [
      userLine("2026-08-17T18:00:00.000Z"),
      assistantLine(OWN_MERGE_CLAIM, "2026-08-17T18:01:00.000Z"),
      userLine("2026-08-17T18:02:00.000Z"),
      assistantLine(OWN_MERGE_CLAIM, "2026-08-17T18:03:00.000Z"),
      userLine("2026-08-17T18:04:00.000Z"),
    ];
    // A record written against the FIRST occurrence must not resolve to the second.
    expect(locateJudgedTurnEnd(lines, "2026-08-17T18:01:30.000Z", "PR #3073 merged")).toBe(2);
  });

  test("returns null when the phrase is in no assistant line", () => {
    const lines = [
      userLine("2026-08-17T18:00:00.000Z"),
      assistantLine("no claim at all", "2026-08-17T18:01:00.000Z"),
      userLine("2026-08-17T18:02:00.000Z"),
    ];
    expect(locateJudgedTurnEnd(lines, "2026-08-17T18:01:30.000Z", "PR #3073 merged")).toBeNull();
  });
});

describe("replayCurrentDetector — the three verdicts are distinguishable", () => {
  // LIVENESS FIRST (mem#1020): assert the fixture reaches the matcher before
  // asserting anything about suppression. Without this, a fixture that matches
  // nothing would satisfy the "suppressed" and "retired" cases below for the
  // wrong reason, and would survive its own negative control — "nothing
  // matched" is stable whether or not the code under test is disabled.
  test("the claim fixture is live: it matches with no backing tool present", () => {
    const detection = detectPreNarrationWithSuppression(
      [assistantLine(APPROVED_CLAIM, "2026-08-13T21:17:00.000Z")],
      new Set<string>()
    );
    expect(detection.matches.map((m) => m.category)).toContain("review-approved");
  });

  test("fires when the claim is unbacked, and reports the CURRENT matched text", () => {
    const lines = [
      userLine("2026-08-13T21:15:00.000Z"),
      assistantLine(APPROVED_CLAIM, "2026-08-13T21:16:00.000Z"),
      userLine("2026-08-13T21:18:00.000Z"),
    ];
    const result = replayCurrentDetector(lines, 2, "review-approved", "phrase");
    expect(result.normalized).toBe("fires");
    // The current text is reported so classification never runs against a
    // record whose matched occurrence a shipped elision has since retired.
    expect(result.currentPhrase).toBe("APPROVED");
    expect(result.currentContext).toContain("0 blocking");
  });

  test("suppressed when the backing tool ran in the window", () => {
    const lines = [
      userLine("2026-08-13T21:15:00.000Z"),
      toolLine("mcp__minsky__session_pr_wait-for-review", "2026-08-13T21:15:30.000Z"),
      assistantLine(APPROVED_CLAIM, "2026-08-13T21:16:00.000Z"),
      userLine("2026-08-13T21:18:00.000Z"),
    ];
    const result = replayCurrentDetector(lines, 3, "review-approved", "phrase");
    expect(result.normalized).toBe("suppressed");
  });

  test("retired vs unreproduced turns on the anchor, not on the absence itself", () => {
    // Same input, same absence of a match: the ONLY difference is whether the
    // turn was verified against its own phrase. A phrase-anchored miss is a
    // fact about the detector; a fallback-anchored one is a fact about this
    // script, and collapsing them would credit the detector for the script's
    // blind spots.
    const lines = [
      userLine("2026-08-13T21:15:00.000Z"),
      assistantLine("a turn making no claim of any kind", "2026-08-13T21:16:00.000Z"),
      userLine("2026-08-13T21:18:00.000Z"),
    ];
    expect(replayCurrentDetector(lines, 2, "review-approved", "phrase").normalized).toBe("retired");
    expect(
      replayCurrentDetector(lines, 2, "review-approved", "timestamp-fallback").normalized
    ).toBe("unreproduced");
  });
});

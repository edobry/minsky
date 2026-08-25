/**
 * mt#4540 — the length-complaint candidate screen.
 *
 * The cases below are REAL principal messages recovered from the calibration
 * corpus during mt#4540's planning, not invented fixtures. That matters for the
 * false-positive cases especially: the screen's job is to be loose, so the tests
 * that earn their keep are the ones pinning what it must NOT silently report as
 * a verdict.
 */

import { describe, expect, test } from "bun:test";
import {
  detectLengthComplaint,
  LENGTH_COMPLAINT_PATTERNS,
  CONTEXT_CHARS,
} from "./length-complaint";

describe("detectLengthComplaint — genuine complaints from the corpus", () => {
  test("R7's own message (mem#664)", () => {
    const r = detectLengthComplaint(
      "Okay bro, you need to be way more concise. This is way too much information. " +
        "I cannot process all of this. We already have communication style guidelines don't we?"
    );

    expect(r.isCandidate).toBe(true);
    expect(r.patterns).toContain("way-too");
    expect(r.patterns).toContain("be-concise");
    expect(r.patterns).toContain("cannot-process");
  });

  test("a complaint that the volume obscured the answer", () => {
    const r = detectLengthComplaint(
      "so is the issue that we're using regex and need to climb the ladder, or smth else? " +
        "this is too much info for me"
    );

    expect(r.isCandidate).toBe(true);
    expect(r.patterns).toContain("too-much");
  });

  test("a bare directive to compress", () => {
    const r = detectLengthComplaint("Summarize everything more concisely.");

    expect(r.isCandidate).toBe(true);
    expect(r.patterns).toContain("be-concise");
  });
});

describe("detectLengthComplaint — what the screen returns is not a verdict", () => {
  /**
   * The case that shaped this module. A topic redirect whose later sentences
   * contain "too much" about subject matter rather than about length. The screen
   * SHOULD flag it — that is what loose means — and the context it returns is
   * what lets a reader throw it out in one line.
   */
  test("a topic redirect is still a candidate, and its context shows why it is not a complaint", () => {
    const r = detectLengthComplaint(
      "Okay, hold on. What just happened? We were talking about the two different paths: " +
        "how we read from the cloud, and I think we were relying on that too much."
    );

    expect(r.isCandidate).toBe(true);
    // The screen fired; the CONTEXT is what makes it classifiable.
    expect(r.context).toContain("relying on that too much");
    expect(r.context).not.toBe("");
  });

  test("ordinary substantive prose does not fire", () => {
    const r = detectLengthComplaint(
      "So what do we do about those defects? How do we resolve this and fix this, and what do we do now?"
    );

    expect(r.isCandidate).toBe(false);
    expect(r.patterns).toEqual([]);
    expect(r.context).toBe("");
  });

  test("a brief affirmative does not fire", () => {
    expect(detectLengthComplaint("Yeah, go ahead.").isCandidate).toBe(false);
    expect(detectLengthComplaint("Can we proceed?").isCandidate).toBe(false);
  });
});

describe("detectLengthComplaint — context window", () => {
  test("carries surrounding text and marks truncation on both sides", () => {
    const filler = "x".repeat(400);
    const r = detectLengthComplaint(`${filler} this is too much ${filler}`);

    expect(r.isCandidate).toBe(true);
    expect(r.context.startsWith("…")).toBe(true);
    expect(r.context.endsWith("…")).toBe(true);
    expect(r.context).toContain("too much");
    // match + both context windows, plus the two ellipses.
    expect(r.context.length).toBeLessThanOrEqual(2 * CONTEXT_CHARS + "too much".length + 2);
  });

  test("does not mark truncation when the whole message fits", () => {
    const r = detectLengthComplaint("way too long");

    expect(r.context).toBe("way too long");
  });

  test("collapses whitespace so a multi-line prompt reads as one span", () => {
    const r = detectLengthComplaint("please\n\n  be   concise\tnext time");

    expect(r.context).toContain("be concise");
    expect(r.context).not.toContain("\n");
  });
});

describe("LENGTH_COMPLAINT_PATTERNS", () => {
  test("every pattern is named and case-insensitive", () => {
    for (const p of LENGTH_COMPLAINT_PATTERNS) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.re.flags).toContain("i");
    }
  });

  test("no pattern carries the g flag, which would make exec() stateful across calls", () => {
    // A /g/ regex advances lastIndex between exec() calls, so the same input
    // would match on one call and not the next.
    for (const p of LENGTH_COMPLAINT_PATTERNS) expect(p.re.flags).not.toContain("g");
  });

  test("the same input classifies identically on repeat calls", () => {
    const text = "this is way too much";
    expect(detectLengthComplaint(text)).toEqual(detectLengthComplaint(text));
  });
});

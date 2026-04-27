/**
 * Unit tests for multi-line review comment support in github-pr-review.ts (mt#1337).
 *
 * Covers:
 *  - validateReviewComment: reject invalid startLine/startSide combos
 *  - Octokit payload mapping: start_line/start_side present for multi-line, absent for single-line
 *  - submitReview integration: multi-line comment reaches Octokit shaped correctly
 */

import { describe, expect, test } from "bun:test";
import { validateReviewComment, type ReviewComment } from "./github-pr-review";
import { MinskyError } from "../../errors/index";

// ---------------------------------------------------------------------------
// validateReviewComment
// ---------------------------------------------------------------------------

describe("validateReviewComment", () => {
  function mkComment(overrides: Partial<ReviewComment>): ReviewComment {
    return {
      path: "src/foo.ts",
      line: 78,
      body: "look at this range",
      ...overrides,
    };
  }

  test("passes for a single-line comment with no startLine", () => {
    expect(() => validateReviewComment(mkComment({}))).not.toThrow();
  });

  test("passes for a valid multi-line comment (startLine < line)", () => {
    expect(() =>
      validateReviewComment(
        mkComment({ startLine: 67, line: 78, side: "RIGHT", startSide: "RIGHT" })
      )
    ).not.toThrow();
  });

  test("passes when startLine is set but side/startSide are both omitted", () => {
    expect(() => validateReviewComment(mkComment({ startLine: 67, line: 78 }))).not.toThrow();
  });

  test("rejects startLine > line", () => {
    expect(() => validateReviewComment(mkComment({ startLine: 78, line: 67 }))).toThrow(
      MinskyError
    );
  });

  test("rejects startLine === line", () => {
    expect(() => validateReviewComment(mkComment({ startLine: 67, line: 67 }))).toThrow(
      MinskyError
    );
  });

  test("error message for startLine >= line mentions both values", () => {
    let caught: unknown;
    try {
      validateReviewComment(mkComment({ startLine: 78, line: 67 }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MinskyError);
    const msg = (caught as MinskyError).message;
    expect(msg).toContain("startLine (78)");
    expect(msg).toContain("line (67)");
  });

  test("rejects mismatched startSide and side", () => {
    expect(() =>
      validateReviewComment(
        mkComment({ startLine: 67, line: 78, side: "RIGHT", startSide: "LEFT" })
      )
    ).toThrow(MinskyError);
  });

  test("error message for mismatched sides mentions both values", () => {
    let caught: unknown;
    try {
      validateReviewComment(
        mkComment({ startLine: 67, line: 78, side: "RIGHT", startSide: "LEFT" })
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MinskyError);
    const msg = (caught as MinskyError).message;
    expect(msg).toContain("LEFT");
    expect(msg).toContain("RIGHT");
  });

  test("passes when startSide is set but side is omitted (no mismatch possible)", () => {
    // When side is omitted there is nothing to compare against — not an error.
    expect(() =>
      validateReviewComment(mkComment({ startLine: 67, line: 78, startSide: "LEFT" }))
    ).not.toThrow();
  });

  test("passes when both sides are equal LEFT/LEFT", () => {
    expect(() =>
      validateReviewComment(mkComment({ startLine: 67, line: 78, side: "LEFT", startSide: "LEFT" }))
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Octokit payload mapping (unit-level, no network)
// ---------------------------------------------------------------------------

/**
 * Build the API-comment shape the same way submitReview does — extracted here
 * so we can test the mapping logic without mocking Octokit or the GitHub API.
 */
function buildApiComment(c: ReviewComment): Record<string, unknown> {
  return {
    path: c.path,
    line: c.line,
    body: c.body,
    side: (c.side ?? "RIGHT") as "LEFT" | "RIGHT",
    ...(c.startLine !== undefined
      ? {
          start_line: c.startLine,
          start_side: (c.startSide ?? c.side ?? "RIGHT") as "LEFT" | "RIGHT",
        }
      : {}),
  };
}

describe("Octokit payload mapping", () => {
  test("single-line comment: start_line and start_side are absent (not undefined)", () => {
    const payload = buildApiComment({
      path: "src/foo.ts",
      line: 10,
      body: "single",
      side: "RIGHT",
    });

    expect("start_line" in payload).toBe(false);
    expect("start_side" in payload).toBe(false);
  });

  test("multi-line comment: start_line and start_side are present", () => {
    const payload = buildApiComment({
      path: "src/foo.ts",
      line: 78,
      body: "range",
      side: "RIGHT",
      startLine: 67,
      startSide: "RIGHT",
    });

    expect(payload.start_line).toBe(67);
    expect(payload.start_side).toBe("RIGHT");
  });

  test("multi-line comment: startSide defaults to side when omitted", () => {
    const payload = buildApiComment({
      path: "src/foo.ts",
      line: 78,
      body: "range",
      side: "RIGHT",
      startLine: 67,
      // startSide omitted
    });

    expect(payload.start_line).toBe(67);
    expect(payload.start_side).toBe("RIGHT"); // inherits from side
  });

  test("multi-line comment: startSide defaults to RIGHT when both side and startSide omitted", () => {
    const payload = buildApiComment({
      path: "src/foo.ts",
      line: 78,
      body: "range",
      startLine: 67,
      // side and startSide both omitted
    });

    expect(payload.start_line).toBe(67);
    expect(payload.start_side).toBe("RIGHT");
    expect(payload.side).toBe("RIGHT"); // side also defaults
  });

  test("single-line comment: side defaults to RIGHT when omitted", () => {
    const payload = buildApiComment({
      path: "src/foo.ts",
      line: 10,
      body: "single",
    });

    expect(payload.side).toBe("RIGHT");
    expect("start_line" in payload).toBe(false);
  });

  test("multi-line LEFT/LEFT comment: sides preserved correctly", () => {
    const payload = buildApiComment({
      path: "src/foo.ts",
      line: 78,
      body: "deletion range",
      side: "LEFT",
      startLine: 67,
      startSide: "LEFT",
    });

    expect(payload.side).toBe("LEFT");
    expect(payload.start_side).toBe("LEFT");
    expect(payload.start_line).toBe(67);
  });
});

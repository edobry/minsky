/**
 * Unit tests for multi-line review comment support in github-pr-review.ts (mt#1337).
 *
 * Covers:
 *  - validateReviewComment: reject invalid startLine/startSide combos
 *  - Octokit payload mapping: start_line/start_side present for multi-line, absent for single-line
 *  - Side inference: when only startSide is provided, side inherits from it
 *
 * Mapping is tested via a local helper that mirrors production logic. submitReview
 * itself is exercised end-to-end through the MCP tool layer, not in this file.
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

  // suggestion field validation
  test("passes for a single-line comment with a 1-line suggestion", () => {
    expect(() =>
      validateReviewComment(mkComment({ line: 10, suggestion: "const x = 1;" }))
    ).not.toThrow();
  });

  test("passes for a multi-line comment with matching suggestion line count", () => {
    // startLine 67, line 78 → 12 lines anchored
    const suggestion = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    expect(() =>
      validateReviewComment(mkComment({ startLine: 67, line: 78, suggestion }))
    ).not.toThrow();
  });

  test("passes for suggestion with trailing newline (trailing newline ignored in count)", () => {
    // 12-line range, suggestion ends with newline — should still match
    const suggestion = `${Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    expect(() =>
      validateReviewComment(mkComment({ startLine: 67, line: 78, suggestion }))
    ).not.toThrow();
  });

  test("rejects single-line comment with multi-line suggestion", () => {
    expect(() =>
      validateReviewComment(mkComment({ line: 10, suggestion: "line 1\nline 2" }))
    ).toThrow(MinskyError);
  });

  test("rejects multi-line comment with wrong suggestion line count (11 instead of 12)", () => {
    const suggestion = Array.from({ length: 11 }, (_, i) => `line ${i + 1}`).join("\n");
    expect(() => validateReviewComment(mkComment({ startLine: 67, line: 78, suggestion }))).toThrow(
      MinskyError
    );
  });

  test("rejects multi-line comment with wrong suggestion line count (13 instead of 12)", () => {
    const suggestion = Array.from({ length: 13 }, (_, i) => `line ${i + 1}`).join("\n");
    expect(() => validateReviewComment(mkComment({ startLine: 67, line: 78, suggestion }))).toThrow(
      MinskyError
    );
  });

  test("error message for suggestion mismatch mentions line counts and path", () => {
    let caught: unknown;
    try {
      validateReviewComment(mkComment({ line: 10, suggestion: "line 1\nline 2" }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MinskyError);
    const msg = (caught as MinskyError).message;
    expect(msg).toContain("src/foo.ts");
    expect(msg).toContain("2 line(s)");
    expect(msg).toContain("1 line(s)");
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
  const resolvedSide = (c.side ?? c.startSide ?? "RIGHT") as "LEFT" | "RIGHT";
  const resolvedBody =
    c.suggestion !== undefined ? `${c.body}\n\n\`\`\`suggestion\n${c.suggestion}\n\`\`\`` : c.body;
  return {
    path: c.path,
    line: c.line,
    body: resolvedBody,
    side: resolvedSide,
    ...(c.startLine !== undefined
      ? {
          start_line: c.startLine,
          start_side: (c.startSide ?? resolvedSide) as "LEFT" | "RIGHT",
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

  test("multi-line comment: side inherits from startSide when only startSide is provided", () => {
    // Reviewer-bot finding on PR #831 — without inference, this case produced
    // side: "RIGHT", start_side: "LEFT" which GitHub rejects with 422.
    const payload = buildApiComment({
      path: "src/foo.ts",
      line: 78,
      body: "deletion range",
      startLine: 67,
      startSide: "LEFT",
      // side omitted — should inherit "LEFT" from startSide
    });

    expect(payload.side).toBe("LEFT");
    expect(payload.start_side).toBe("LEFT");
    expect(payload.start_line).toBe(67);
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

  // suggestion body mapping
  test("comment without suggestion: body unchanged", () => {
    const payload = buildApiComment({
      path: "src/foo.ts",
      line: 10,
      body: "this looks wrong",
    });

    expect(payload.body).toBe("this looks wrong");
  });

  test("comment with suggestion: body contains fenced suggestion block", () => {
    const payload = buildApiComment({
      path: "src/foo.ts",
      line: 10,
      body: "use a const instead",
      suggestion: "const x = 1;",
    });

    expect(payload.body).toBe("use a const instead\n\n```suggestion\nconst x = 1;\n```");
  });

  test("comment with multi-line suggestion: body contains full suggestion fence", () => {
    const suggestion = "const x = 1;\nconst y = 2;";
    const payload = buildApiComment({
      path: "src/foo.ts",
      line: 11,
      startLine: 10,
      body: "simplify",
      suggestion,
    });

    expect(payload.body).toBe(`simplify\n\n\`\`\`suggestion\n${suggestion}\n\`\`\``);
  });
});

/**
 * Unit tests for github-pr-review.ts.
 *
 * Covers:
 *  - validateReviewComment: reject invalid startLine/startSide combos (mt#1337)
 *  - Octokit payload mapping: start_line/start_side present for multi-line, absent for single-line
 *  - Side inference: when only startSide is provided, side inherits from it
 *  - resolveReviewerRole + assertReviewerRoleAvailable: identity routing (mt#1510)
 *
 * Mapping is tested via a local helper that mirrors production logic. submitReview
 * itself is exercised end-to-end through the MCP tool layer, not in this file.
 */

import { describe, expect, test } from "bun:test";
import {
  validateReviewComment,
  resolveReviewerRole,
  assertReviewerRoleAvailable,
  type ReviewComment,
} from "./github-pr-review";
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

  test("passes for suggestion with multiple trailing newlines (all stripped before counting)", () => {
    // Single-line range, suggestion ends with "\n\n\n" — all trailing newlines stripped,
    // so the count is still 1 and validation passes.
    expect(() =>
      validateReviewComment(mkComment({ line: 10, suggestion: "const x = 1;\n\n\n" }))
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

  // BLOCKING 1: CRLF normalization in line-count validation
  test("CRLF suggestion is counted correctly (2 CRLF-separated lines = 2 lines)", () => {
    // A 2-line range with a CRLF-separated 2-line suggestion should pass.
    // Without normalization, split("\n") on "line1\r\nline2" produces
    // ["line1\r", "line2"], which is 2 elements but the \r leaks in.
    expect(() =>
      validateReviewComment(mkComment({ startLine: 9, line: 10, suggestion: "line 1\r\nline 2" }))
    ).not.toThrow();
  });

  test("lone CR suggestion is counted correctly (2 CR-separated lines = 2 lines)", () => {
    // Old Mac line endings: \r without \n.
    expect(() =>
      validateReviewComment(mkComment({ startLine: 9, line: 10, suggestion: "line 1\rline 2" }))
    ).not.toThrow();
  });

  test("CRLF single-line suggestion with trailing CRLF passes single-line anchor", () => {
    // "const x = 1;\r\n" — after normalization this is "const x = 1;\n",
    // then trailing newline stripping makes it "const x = 1;" — 1 line.
    expect(() =>
      validateReviewComment(mkComment({ line: 10, suggestion: "const x = 1;\r\n" }))
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Octokit payload mapping (unit-level, no network)
// ---------------------------------------------------------------------------

/**
 * Build the API-comment shape the same way submitReview does — extracted here
 * so we can test the mapping logic without mocking Octokit or the GitHub API.
 *
 * Keep this helper in sync with the production mapper in github-pr-review.ts.
 */
function buildApiComment(c: ReviewComment): Record<string, unknown> {
  const resolvedSide = (c.side ?? c.startSide ?? "RIGHT") as "LEFT" | "RIGHT";

  // 1. Normalize line endings (\r\n and \r -> \n) then strip trailing newlines.
  const normalizedSuggestion =
    c.suggestion !== undefined
      ? c.suggestion.replace(/\r\n?/g, "\n").replace(/\n+$/, "")
      : undefined;

  let resolvedBody: string;
  if (normalizedSuggestion !== undefined) {
    // Compute fence length: longest backtick run in content + 1, minimum 3.
    const backtickRuns = normalizedSuggestion.match(/`+/g);
    const longestRun = backtickRuns ? Math.max(...backtickRuns.map((r) => r.length)) : 0;
    const fenceLen = Math.max(3, longestRun + 1);
    const fence = "`".repeat(fenceLen);
    resolvedBody = `${c.body}\n\n${fence}suggestion\n${normalizedSuggestion}\n${fence}`;
  } else {
    resolvedBody = c.body;
  }

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
    // Mirror the production mapper: forward inReplyTo as in_reply_to (mt#1345).
    ...(c.inReplyTo !== undefined ? { in_reply_to: c.inReplyTo } : {}),
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

  test("suggestion with multiple trailing newlines produces exactly one trailing newline inside fence", () => {
    // suggestion ends with "\n\n\n" — normalization must strip all trailing newlines
    // so the fence body is "const x = 1;\n" not "const x = 1;\n\n\n\n"
    const payload = buildApiComment({
      path: "src/foo.ts",
      line: 10,
      body: "use a const",
      suggestion: "const x = 1;\n\n\n",
    });

    const body = payload.body as string;
    // The fenced block must contain exactly one newline before the closing fence.
    expect(body).toBe("use a const\n\n```suggestion\nconst x = 1;\n```");
    // Specifically, no double-blank-line inside the fence.
    expect(body).not.toContain("const x = 1;\n\n");
  });

  // BLOCKING 1: CRLF normalization in payload mapper
  test("suggestion with CRLF separators: no carriage-return leaks into fenced block", () => {
    // Simulates a Windows-style suggestion where lines are separated by \r\n.
    const payload = buildApiComment({
      path: "src/foo.ts",
      line: 10,
      body: "use a const",
      suggestion: "const x = 1;\r\nconst y = 2;",
    });

    const body = payload.body as string;
    // No \r should appear anywhere in the output.
    expect(body).not.toContain("\r");
    // The suggestion content must be present with plain \n separators.
    expect(body).toContain("const x = 1;\nconst y = 2;");
  });

  // inReplyTo field mapping (mt#1345)
  test("comment with inReplyTo: in_reply_to is present in API payload", () => {
    const payload = buildApiComment({
      path: "src/foo.ts",
      line: 10,
      body: "still applies — see evidence",
      inReplyTo: 98765,
    });

    expect(payload.in_reply_to).toBe(98765);
  });

  test("comment without inReplyTo: in_reply_to is absent from API payload", () => {
    const payload = buildApiComment({
      path: "src/foo.ts",
      line: 10,
      body: "new comment",
    });

    expect("in_reply_to" in payload).toBe(false);
  });

  test("multi-comment array: mixed inReplyTo — present on some, absent on others", () => {
    const comments: ReviewComment[] = [
      { path: "src/a.ts", line: 1, body: "new top-level" },
      { path: "src/b.ts", line: 2, body: "reply to existing", inReplyTo: 12345 },
      { path: "src/c.ts", line: 3, body: "another new top-level" },
    ];

    const payloads = comments.map(buildApiComment);
    const [first, second, third] = payloads as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];

    expect("in_reply_to" in first).toBe(false);
    expect(second.in_reply_to).toBe(12345);
    expect("in_reply_to" in third).toBe(false);
  });

  // BLOCKING 2: Dynamic fence length when suggestion contains backticks
  test("suggestion containing a line with 3 backticks: fence uses 4 or more backticks", () => {
    // If the suggestion has triple-backticks, a triple-backtick fence would
    // terminate early. The mapper must use a longer fence.
    const payload = buildApiComment({
      path: "src/foo.ts",
      line: 10,
      body: "check this",
      suggestion: "const code = `one` + `two` + `three`;\nif (a) { return ```xyz```; }",
    });

    const body = payload.body as string;
    // The fence must use at least 4 backticks (3 in content, so +1 = 4).
    expect(body).toMatch(/````+suggestion\n/);
    // The suggestion content (with its backticks) must survive intact.
    expect(body).toContain("```xyz```");
    // Opening and closing fence lengths must match.
    const openMatch = body.match(/(`+)suggestion\n/);
    if (openMatch === null) {
      throw new Error("fence open-marker not found in body");
    }
    const fenceStr = openMatch[1];
    // Closing fence must be present at the end.
    expect(body.endsWith(`\n${fenceStr}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveReviewerRole — event-type → bot identity mapping (mt#1510)
// ---------------------------------------------------------------------------

describe("resolveReviewerRole", () => {
  test("COMMENT defaults to implementer when no identity is supplied", () => {
    expect(resolveReviewerRole("COMMENT")).toBe("implementer");
  });

  test("APPROVE defaults to reviewer when no identity is supplied", () => {
    expect(resolveReviewerRole("APPROVE")).toBe("reviewer");
  });

  test("REQUEST_CHANGES defaults to reviewer when no identity is supplied", () => {
    expect(resolveReviewerRole("REQUEST_CHANGES")).toBe("reviewer");
  });

  test("explicit identity overrides the COMMENT default", () => {
    // Override path: a caller can deliberately post a COMMENT under the
    // reviewer identity (e.g., to surface an adversarial observation as a
    // non-blocking comment from the reviewer App).
    expect(resolveReviewerRole("COMMENT", "reviewer")).toBe("reviewer");
  });

  test("explicit identity overrides the APPROVE default", () => {
    // Override path: post an APPROVE under the implementer identity. GitHub
    // will still block self-approval for App-authored PRs, but this is a
    // legitimate request shape — the role check is the caller's choice, and
    // the spec calls for explicit override behaviour even when the default
    // would normally win.
    expect(resolveReviewerRole("APPROVE", "implementer")).toBe("implementer");
  });

  test("explicit identity overrides the REQUEST_CHANGES default", () => {
    expect(resolveReviewerRole("REQUEST_CHANGES", "implementer")).toBe("implementer");
  });
});

// ---------------------------------------------------------------------------
// assertReviewerRoleAvailable — reviewer-not-configured guard (mt#1510)
// ---------------------------------------------------------------------------

describe("assertReviewerRoleAvailable", () => {
  test("passes when COMMENT is requested under the implementer role", () => {
    // The implementer App is always configured when any service-account
    // is in use, so COMMENT requests never hit the guard.
    expect(() => assertReviewerRoleAvailable("COMMENT", "implementer", () => true)).not.toThrow();
  });

  test("passes when APPROVE is requested under the implementer role", () => {
    // Explicit override path: the caller is consciously bypassing the
    // event→role default, so the reviewer-config check doesn't apply.
    expect(() => assertReviewerRoleAvailable("APPROVE", "implementer", () => false)).not.toThrow();
  });

  test("passes when APPROVE+reviewer is requested AND reviewer is configured", () => {
    expect(() =>
      assertReviewerRoleAvailable("APPROVE", "reviewer", (role) => role === "reviewer")
    ).not.toThrow();
  });

  test("passes when REQUEST_CHANGES+reviewer is requested AND reviewer is configured", () => {
    expect(() =>
      assertReviewerRoleAvailable("REQUEST_CHANGES", "reviewer", (role) => role === "reviewer")
    ).not.toThrow();
  });

  test("passes when COMMENT+reviewer is requested AND reviewer is unconfigured", () => {
    // The guard explicitly skips COMMENT — even with an explicit reviewer
    // override, COMMENTs aren't subject to GitHub's self-approval block, so
    // a silent fallback is acceptable here. (The reviewer-not-configured
    // signal is communicated separately via getServiceIdentity, not a throw.)
    expect(() => assertReviewerRoleAvailable("COMMENT", "reviewer", () => false)).not.toThrow();
  });

  test("throws when APPROVE+reviewer is requested but reviewer is NOT configured", () => {
    expect(() => assertReviewerRoleAvailable("APPROVE", "reviewer", () => false)).toThrow(
      MinskyError
    );
  });

  test("throws when REQUEST_CHANGES+reviewer is requested but reviewer is NOT configured", () => {
    expect(() => assertReviewerRoleAvailable("REQUEST_CHANGES", "reviewer", () => false)).toThrow(
      MinskyError
    );
  });

  test("error message names github.reviewer.serviceAccount and the requested event", () => {
    let caught: unknown;
    try {
      assertReviewerRoleAvailable("APPROVE", "reviewer", () => false);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MinskyError);
    const msg = (caught as MinskyError).message;
    expect(msg).toContain("github.reviewer.serviceAccount");
    expect(msg).toContain("APPROVE");
    // The actionable hint must surface the COMMENT and identity:"implementer"
    // alternatives so the caller sees a path forward without grepping docs.
    expect(msg).toContain("COMMENT");
    expect(msg).toContain('identity: "implementer"');
  });

  test("passes when isRoleConfigured is undefined (older test-stub fallback)", () => {
    // Production code paths populated by `requireGitHubContext` always supply
    // isRoleConfigured. Older test stubs that build a GitHubContext literal
    // and omit it should not be retroactively broken — the guard treats
    // missing isRoleConfigured as 'trust the caller'.
    expect(() => assertReviewerRoleAvailable("APPROVE", "reviewer", undefined)).not.toThrow();
  });
});

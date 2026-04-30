/**
 * Tests for the replay-verification aggregate helpers (mt#1403).
 *
 * Tests the pure summarization logic extracted into replay-summary.ts.
 * Does NOT make real API calls — uses synthetic tool-call fixtures.
 */

import { describe, test, expect } from "bun:test";
import { buildAttemptResult, aggregateSummary } from "../src/replay-summary";
import { composeReviewBody } from "../src/compose-review";
import { sanitizeReviewBody } from "../src/sanitize";
import type { ReviewToolCall } from "../src/output-tools";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFinding(severity: "BLOCKING" | "NON-BLOCKING" | "PRE-EXISTING"): ReviewToolCall {
  return {
    name: "submit_finding",
    args: {
      severity,
      file: "src/foo.ts",
      line: 42,
      summary: "A finding",
      details: "Details of the finding.",
    },
  };
}

function makeConclude(event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"): ReviewToolCall {
  return {
    name: "conclude_review",
    args: {
      event,
      summary: "Summary of the review.",
    },
  };
}

function makeInline(): ReviewToolCall {
  return {
    name: "submit_inline_comment",
    args: {
      file: "src/bar.ts",
      line: 10,
      body: "An inline comment.",
    },
  };
}

function makeSpecVerification(status: "Met" | "Not Met" | "N/A"): ReviewToolCall {
  return {
    name: "submit_spec_verification",
    args: {
      criterion: "Some criterion",
      status,
      evidence: "Evidence here.",
    },
  };
}

// ---------------------------------------------------------------------------
// buildAttemptResult
// ---------------------------------------------------------------------------

describe("buildAttemptResult", () => {
  test("returns correct attempt index", () => {
    const result = buildAttemptResult(2, [], "", "passthrough", "passthrough");
    expect(result.attempt).toBe(2);
  });

  test("counts tool calls correctly", () => {
    const toolCalls: ReviewToolCall[] = [
      makeFinding("BLOCKING"),
      makeInline(),
      makeConclude("REQUEST_CHANGES"),
    ];
    const result = buildAttemptResult(1, toolCalls, "scratch", "passthrough", "passthrough");
    expect(result.toolCallCount).toBe(3);
  });

  test("measures scratch text length", () => {
    const scratchText = "I will now analyze the diff carefully.";
    const result = buildAttemptResult(1, [], scratchText, "passthrough", "passthrough");
    expect(result.scratchTextLength).toBe(scratchText.length);
  });

  test("counts BLOCKING findings correctly", () => {
    const toolCalls: ReviewToolCall[] = [
      makeFinding("BLOCKING"),
      makeFinding("NON-BLOCKING"),
      makeFinding("BLOCKING"),
      makeFinding("PRE-EXISTING"),
    ];
    const result = buildAttemptResult(1, toolCalls, "", "passthrough", "passthrough");
    expect(result.blockingFindingCount).toBe(2);
  });

  test("counts zero BLOCKING findings when only NON-BLOCKING", () => {
    const toolCalls: ReviewToolCall[] = [makeFinding("NON-BLOCKING"), makeFinding("PRE-EXISTING")];
    const result = buildAttemptResult(1, toolCalls, "", "passthrough", "passthrough");
    expect(result.blockingFindingCount).toBe(0);
  });

  test("extracts conclude_review event", () => {
    const toolCalls: ReviewToolCall[] = [makeFinding("BLOCKING"), makeConclude("REQUEST_CHANGES")];
    const result = buildAttemptResult(1, toolCalls, "", "passthrough", "passthrough");
    expect(result.concludeEvent).toBe("REQUEST_CHANGES");
  });

  test("uses last conclude_review event when multiple present (model self-correction)", () => {
    const toolCalls: ReviewToolCall[] = [
      makeConclude("APPROVE"),
      makeFinding("BLOCKING"),
      makeConclude("REQUEST_CHANGES"),
    ];
    const result = buildAttemptResult(1, toolCalls, "", "passthrough", "passthrough");
    expect(result.concludeEvent).toBe("REQUEST_CHANGES");
  });

  test("returns NONE as concludeEvent when no conclude_review call", () => {
    const toolCalls: ReviewToolCall[] = [makeFinding("BLOCKING")];
    const result = buildAttemptResult(1, toolCalls, "", "passthrough", "passthrough");
    expect(result.concludeEvent).toBe("NONE");
  });

  test("records scratch sanitize action", () => {
    const result = buildAttemptResult(1, [], "", "stripped", "passthrough");
    expect(result.scratchSanitize).toBe("stripped");
  });

  test("records posted body sanitize action", () => {
    const result = buildAttemptResult(1, [], "", "passthrough", "errored");
    expect(result.postedBodySanitize).toBe("errored");
  });

  test("returns all expected fields", () => {
    const result = buildAttemptResult(1, [], "", "passthrough", "passthrough");
    expect(result).toHaveProperty("attempt");
    expect(result).toHaveProperty("toolCallCount");
    expect(result).toHaveProperty("scratchTextLength");
    expect(result).toHaveProperty("scratchSanitize");
    expect(result).toHaveProperty("postedBodySanitize");
    expect(result).toHaveProperty("blockingFindingCount");
    expect(result).toHaveProperty("concludeEvent");
  });
});

// ---------------------------------------------------------------------------
// aggregateSummary
// ---------------------------------------------------------------------------

describe("aggregateSummary", () => {
  test("returns correct prsTested count", () => {
    const perPR = [
      { prNumber: 793, attempts: [] },
      { prNumber: 794, attempts: [] },
    ];
    const summary = aggregateSummary(perPR, 3);
    expect(summary.prsTested).toBe(2);
  });

  test("returns attemptsPerPR from argument", () => {
    const perPR = [{ prNumber: 793, attempts: [] }];
    const summary = aggregateSummary(perPR, 5);
    expect(summary.attemptsPerPR).toBe(5);
  });

  test("counts total attempts across all PRs", () => {
    const attempt = buildAttemptResult(1, [], "", "passthrough", "passthrough");
    const perPR = [
      { prNumber: 793, attempts: [attempt, attempt, attempt] },
      { prNumber: 794, attempts: [attempt, attempt] },
    ];
    const summary = aggregateSummary(perPR, 3);
    expect(summary.totalAttempts).toBe(5);
  });

  test("counts scratchSanitizerFires correctly", () => {
    const pass = buildAttemptResult(1, [], "", "passthrough", "passthrough");
    const fired = buildAttemptResult(2, [], "", "stripped", "passthrough");
    const perPR = [
      { prNumber: 793, attempts: [pass, fired, pass] },
      { prNumber: 794, attempts: [fired, fired] },
    ];
    const summary = aggregateSummary(perPR, 3);
    expect(summary.scratchSanitizerFires).toBe(3); // 1 + 2
  });

  test("counts postedBodySanitizerFires correctly", () => {
    const pass = buildAttemptResult(1, [], "", "passthrough", "passthrough");
    const fired = buildAttemptResult(2, [], "", "passthrough", "errored");
    const perPR = [
      { prNumber: 793, attempts: [pass, fired, pass] },
      { prNumber: 794, attempts: [pass, pass] },
    ];
    const summary = aggregateSummary(perPR, 3);
    expect(summary.postedBodySanitizerFires).toBe(1);
  });

  test("structuralFixVerified is true when postedBodySanitizerFires === 0", () => {
    const attempt = buildAttemptResult(1, [], "", "passthrough", "passthrough");
    const perPR = [{ prNumber: 793, attempts: [attempt, attempt, attempt] }];
    const summary = aggregateSummary(perPR, 3);
    expect(summary.structuralFixVerified).toBe(true);
  });

  test("structuralFixVerified is false when postedBodySanitizerFires > 0", () => {
    const pass = buildAttemptResult(1, [], "", "passthrough", "passthrough");
    const fired = buildAttemptResult(2, [], "", "passthrough", "stripped");
    const perPR = [{ prNumber: 793, attempts: [pass, fired, pass] }];
    const summary = aggregateSummary(perPR, 3);
    expect(summary.structuralFixVerified).toBe(false);
  });

  test("handles empty perPR array", () => {
    const summary = aggregateSummary([], 3);
    expect(summary.prsTested).toBe(0);
    expect(summary.totalAttempts).toBe(0);
    expect(summary.scratchSanitizerFires).toBe(0);
    expect(summary.postedBodySanitizerFires).toBe(0);
    expect(summary.structuralFixVerified).toBe(true); // vacuously true: no fires
  });

  test("structuralFixVerified is true when scratchFired but postedBodyPassed", () => {
    // The key property: scratch can fire, but if the posted body passes, the fix is verified.
    const scratchFired = buildAttemptResult(1, [], "", "stripped", "passthrough");
    const perPR = [{ prNumber: 793, attempts: [scratchFired, scratchFired, scratchFired] }];
    const summary = aggregateSummary(perPR, 3);
    expect(summary.scratchSanitizerFires).toBe(3);
    expect(summary.postedBodySanitizerFires).toBe(0);
    expect(summary.structuralFixVerified).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// composeReviewBody + sanitize integration
// ---------------------------------------------------------------------------

describe("empty toolCalls handling", () => {
  test("composeReviewBody produces passthrough-safe body for empty toolCalls", () => {
    const { body } = composeReviewBody([]);
    const sanitized = sanitizeReviewBody(body);
    expect(sanitized.action).toBe("passthrough");
  });

  test("composeReviewBody body contains no CoT scratch phrases for empty toolCalls", () => {
    const { body } = composeReviewBody([]);
    // The no-findings body should NOT contain any strong scratch patterns
    expect(body).not.toMatch(/Calling read_file/);
    expect(body).not.toMatch(/This time for sure/);
    expect(body).not.toMatch(/Let's try again/);
    expect(body).not.toMatch(/Go\./);
  });
});

describe("composeReviewBody + sanitize integration for realistic tool-call sets", () => {
  test("APPROVE review with findings passes sanitizer", () => {
    const toolCalls: ReviewToolCall[] = [
      makeFinding("NON-BLOCKING"),
      makeSpecVerification("Met"),
      makeConclude("APPROVE"),
    ];
    const { body } = composeReviewBody(toolCalls);
    const sanitized = sanitizeReviewBody(body);
    expect(sanitized.action).toBe("passthrough");
  });

  test("REQUEST_CHANGES review with BLOCKING finding passes sanitizer", () => {
    const toolCalls: ReviewToolCall[] = [
      makeFinding("BLOCKING"),
      makeFinding("NON-BLOCKING"),
      makeConclude("REQUEST_CHANGES"),
    ];
    const { body } = composeReviewBody(toolCalls);
    const sanitized = sanitizeReviewBody(body);
    expect(sanitized.action).toBe("passthrough");
  });

  test("review with inline comments passes sanitizer", () => {
    const toolCalls: ReviewToolCall[] = [makeInline(), makeInline(), makeConclude("COMMENT")];
    const { body } = composeReviewBody(toolCalls);
    const sanitized = sanitizeReviewBody(body);
    expect(sanitized.action).toBe("passthrough");
  });

  test("review with spec verifications passes sanitizer", () => {
    const toolCalls: ReviewToolCall[] = [
      makeSpecVerification("Met"),
      makeSpecVerification("Not Met"),
      makeSpecVerification("N/A"),
      makeConclude("REQUEST_CHANGES"),
    ];
    const { body } = composeReviewBody(toolCalls);
    const sanitized = sanitizeReviewBody(body);
    expect(sanitized.action).toBe("passthrough");
  });

  test("body composed from tool calls never contains 'Calling read_file'", () => {
    // This is the key structural guarantee: if the model leaks CoT into scratch
    // (output.text) but uses tools for structured output, the composed body
    // cannot contain the scratch content.
    const toolCalls: ReviewToolCall[] = [makeFinding("BLOCKING"), makeConclude("REQUEST_CHANGES")];
    const { body } = composeReviewBody(toolCalls);
    expect(body).not.toContain("Calling read_file");
    expect(body).not.toContain("I will");
    expect(body).not.toContain("I'll");
    expect(body).not.toContain("Go.");
  });
});

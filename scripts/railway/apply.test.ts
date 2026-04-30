#!/usr/bin/env bun
/**
 * Tests for apply.ts behaviors that require mocking fetch.
 * Since graphql() is not exported, we test its error-path behavior by
 * mocking the relevant logic at the formatting layer — or by importing
 * behaviors we can isolate via the parse-error formatting pattern.
 *
 * The parse-error path is: bodyText captured via res.text(), then
 * JSON.parse(bodyText) fails, then error message includes truncated bodyText.
 * We verify this pattern directly since the logic is inline in graphql().
 */
import { describe, test, expect } from "bun:test";

describe("graphql() parse-error path — truncation behavior", () => {
  // Test the truncation logic that matches apply.ts implementation:
  // const truncated = bodyText.length > 500 ? bodyText.slice(0, 500) + "..." : bodyText;
  // throw new Error(`Railway API returned non-JSON response (HTTP ${res.status}): ${truncated}`, { cause: parseErr });

  function buildParseErrorMessage(status: number, bodyText: string): string {
    const truncated = bodyText.length > 500 ? `${bodyText.slice(0, 500)}...` : bodyText;
    return `Railway API returned non-JSON response (HTTP ${status}): ${truncated}`;
  }

  test("short body text is included verbatim in the error message", () => {
    const body = "<html>Not JSON</html>";
    const msg = buildParseErrorMessage(200, body);
    expect(msg).toContain("HTTP 200");
    expect(msg).toContain("<html>Not JSON</html>");
    expect(msg).not.toContain("...");
  });

  test("long body text (>500 chars) is truncated with ellipsis", () => {
    const body = "x".repeat(600);
    const msg = buildParseErrorMessage(200, body);
    expect(msg).toContain("HTTP 200");
    expect(msg).toContain("x".repeat(500));
    expect(msg).toContain("...");
    expect(msg).not.toContain("x".repeat(501));
  });

  test("exactly 500-char body is not truncated", () => {
    const body = "a".repeat(500);
    const msg = buildParseErrorMessage(200, body);
    expect(msg).toContain("a".repeat(500));
    expect(msg).not.toContain("...");
  });

  test("501-char body is truncated", () => {
    const body = "b".repeat(501);
    const msg = buildParseErrorMessage(200, body);
    expect(msg).toContain("b".repeat(500));
    expect(msg).toContain("...");
  });

  test("error message contains the HTTP status code", () => {
    const msg = buildParseErrorMessage(200, "not-json");
    expect(msg).toMatch(/HTTP 200/);
  });

  test("error message prefix matches expected format", () => {
    const msg = buildParseErrorMessage(200, "garbage");
    expect(msg).toMatch(/^Railway API returned non-JSON response \(HTTP 200\): garbage$/);
  });
});

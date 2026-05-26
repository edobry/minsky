/**
 * Tests for buildSubprocessFailurePayload (PR #962 R1).
 *
 * Pins the McpErrorPayload contract for `git commit` subprocess failures:
 *   - summary stays ≤120 chars (the documented McpErrorPayload contract)
 *   - the truncated subprocess preview lives in `details.tail`
 *   - `details.truncated` is a boolean reflecting whether truncation happened
 *   - the full output is preserved verbatim in `subprocessOutput`
 *   - `details` is omitted entirely when there is no subprocess output
 */
import { describe, expect, test } from "bun:test";
import {
  buildSubprocessFailurePayload,
  SUBPROCESS_OUTPUT_TRUNCATE_LIMIT,
} from "./workflow-commands";
import { McpErrorCode } from "@minsky/domain/errors/mcp-error-codes";

const SUMMARY_CONTRACT_MAX = 120;

describe("buildSubprocessFailurePayload", () => {
  test("summary stays ≤120 chars regardless of subprocess output length", () => {
    const huge = "x".repeat(10_000);
    for (const kind of ["commit-msg", "pre-commit", "unknown"] as const) {
      const payload = buildSubprocessFailurePayload(kind, huge);
      expect(payload.summary.length).toBeLessThanOrEqual(SUMMARY_CONTRACT_MAX);
    }
  });

  test("summary is the canonical terse string for each hookKind", () => {
    expect(buildSubprocessFailurePayload("commit-msg", "x").summary).toBe(
      "commit-msg hook blocked the commit"
    );
    expect(buildSubprocessFailurePayload("pre-commit", "x").summary).toBe(
      "pre-commit hook blocked the commit"
    );
    expect(buildSubprocessFailurePayload("unknown", "x").summary).toBe("git commit failed");
  });

  test("hookKind maps to the matching code", () => {
    expect(buildSubprocessFailurePayload("commit-msg", "x").code).toBe(
      McpErrorCode.COMMIT_MSG_FAILED
    );
    expect(buildSubprocessFailurePayload("pre-commit", "x").code).toBe(
      McpErrorCode.PRE_COMMIT_FAILED
    );
    expect(buildSubprocessFailurePayload("unknown", "x").code).toBe(McpErrorCode.SUBPROCESS_FAILED);
  });

  test("details.tail contains the truncated subprocess preview, surrogate-safe", () => {
    const huge = `🔍 ${"x".repeat(SUBPROCESS_OUTPUT_TRUNCATE_LIMIT)}`;
    const payload = buildSubprocessFailurePayload("pre-commit", huge);
    const details = payload.details;
    if (!details) throw new Error("expected details to be defined for non-empty output");
    expect(typeof details.tail).toBe("string");
    expect((details.tail as string).length).toBeLessThanOrEqual(SUBPROCESS_OUTPUT_TRUNCATE_LIMIT);
    // Surrogate safety: result must roundtrip through JSON.
    expect(() => JSON.parse(JSON.stringify(details))).not.toThrow();
  });

  test("details.truncated reflects whether truncation actually happened", () => {
    const short = "x".repeat(50);
    const longEnough = "x".repeat(SUBPROCESS_OUTPUT_TRUNCATE_LIMIT + 1);

    const shortPayload = buildSubprocessFailurePayload("pre-commit", short);
    const shortDetails = shortPayload.details;
    if (!shortDetails) throw new Error("expected details for short output");
    expect(shortDetails.truncated).toBe(false);
    expect(shortDetails.tail).toBe(short);

    const longPayload = buildSubprocessFailurePayload("pre-commit", longEnough);
    const longDetails = longPayload.details;
    if (!longDetails) throw new Error("expected details for long output");
    expect(longDetails.truncated).toBe(true);
  });

  test("subprocessOutput field carries the full output verbatim (not truncated)", () => {
    const huge = "x".repeat(5000);
    const payload = buildSubprocessFailurePayload("pre-commit", huge);
    expect(payload.subprocessOutput).toBe(huge);
    expect(payload.subprocessOutput.length).toBe(5000);
  });

  test("details is omitted when subprocessOutput is empty", () => {
    const payload = buildSubprocessFailurePayload("pre-commit", "");
    expect(payload.details).toBeUndefined();
    expect(payload.summary).toBe("pre-commit hook blocked the commit");
    expect(payload.subprocessOutput).toBe("");
  });
});

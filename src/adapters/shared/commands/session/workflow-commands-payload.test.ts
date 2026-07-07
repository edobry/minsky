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
  detectFailingStep,
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

  // mt#2635: the ESLint-warning-threshold failure is the real-world case
  // that motivated bumping SUBPROCESS_OUTPUT_TRUNCATE_LIMIT (mt#2637 R1
  // diagnosis: 10 warnings, discovered only by manually re-running
  // pre-commit.ts because the MCP error carried no detail).
  test("details.failingStep names the ESLint warning-threshold check", () => {
    const hookOutput =
      "🔍 Running ESLint with strict quality gates...\n" +
      "⚠️ ⚠️ ⚠️ TOO MANY WARNINGS! COMMIT BLOCKED! ⚠️ ⚠️ ⚠️\n" +
      "Warnings: 10 (threshold: 0)";
    const payload = buildSubprocessFailurePayload("pre-commit", hookOutput);
    expect(payload.details?.failingStep).toBe("ESLint (warning threshold)");
    expect(payload.details?.tail).toContain("TOO MANY WARNINGS");
  });

  test("details.failingStep is absent (not just falsy) when no known banner matches", () => {
    const payload = buildSubprocessFailurePayload(
      "pre-commit",
      "fatal: unable to write commit object"
    );
    expect(payload.details).toBeDefined();
    expect(payload.details && "failingStep" in payload.details).toBe(false);
  });
});

describe("detectFailingStep", () => {
  // mt#2635 PR #1811 R1: these strings are copied VERBATIM from the
  // `log.cli(...)` / `log.error(...)` calls in src/hooks/pre-commit.ts and
  // src/hooks/commit-msg.ts (source of truth — see the coupling note on
  // KNOWN_FAILING_STEP_MARKERS in workflow-commands.ts). Pinning the real
  // banner text here means a future edit to either hook's wording breaks
  // this test loudly, instead of `failingStep` silently stopping to appear
  // in production error messages.
  test("recognizes each known pre-commit.ts / commit-msg.ts failure banner", () => {
    expect(detectFailingStep("⚠️ ⚠️ ⚠️ TOO MANY WARNINGS! COMMIT BLOCKED! ⚠️ ⚠️ ⚠️")).toBe(
      "ESLint (warning threshold)"
    );
    expect(detectFailingStep("❌ ❌ ❌ LINTER ERRORS DETECTED! COMMIT BLOCKED! ❌ ❌ ❌")).toBe(
      "ESLint (errors)"
    );
    expect(
      detectFailingStep("❌ 🚨 SECRETS DETECTED BY GITLEAKS! Commit blocked for security.")
    ).toBe("gitleaks (secret scan)");
    expect(detectFailingStep("❌ Node.js shims detected in staged files! Commit blocked.")).toBe(
      "Node-shim guard"
    );
    expect(detectFailingStep("NUL byte(s) detected in staged text files. Commit blocked.")).toBe(
      "NUL-byte guard"
    );
    expect(detectFailingStep("❌ TypeScript type errors found! Commit blocked.")).toBe(
      "TypeScript typecheck"
    );
    expect(
      detectFailingStep("❌ Executable entry points missing execute permission! Commit blocked.")
    ).toBe("hook-file permission check");
    expect(
      detectFailingStep("❌ Variable naming issues found! Please fix them before committing.")
    ).toBe("variable-naming check");
    expect(
      detectFailingStep("❌ Commit message validation failed:\n   • Invalid commit message format")
    ).toBe("commit-msg format validation");
  });

  test("returns undefined for unrecognized output (safe degradation)", () => {
    expect(detectFailingStep("fatal: unable to write commit object")).toBeUndefined();
    expect(detectFailingStep("")).toBeUndefined();
  });

  // Regression: an earlier draft of KNOWN_FAILING_STEP_MARKERS matched the
  // bare phrase "variable naming issues found", which also matches
  // pre-commit.ts's SUCCESS banner for the same check ("✅ No variable
  // naming issues found."). That false-positive would have mislabeled a
  // DIFFERENT check's real failure as "variable-naming check" whenever the
  // variable-naming check itself had already passed earlier in the same
  // pre-commit run (its success line stays in the captured stdout).
  test("does not false-positive on the variable-naming check's SUCCESS banner", () => {
    expect(detectFailingStep("✅ No variable naming issues found.")).toBeUndefined();
  });
});

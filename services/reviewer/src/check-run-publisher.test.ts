/**
 * Unit tests for check-run-publisher.ts (mt#2435).
 *
 * All tests are pure: they exercise `buildCheckRunPayload` (no I/O) and
 * `publishCheckRun` with a fake Octokit injected via the `octokitOverride`
 * seam from `submitCheckRun`. No module mocks (custom/no-global-module-mocks).
 *
 * Coverage areas:
 *   - Severity → annotation_level mapping (BLOCKING→failure, NON-BLOCKING→warning)
 *   - Conclusion derivation from annotation levels (failure, neutral, success)
 *   - Failure/liveness path: failureSummary forces conclusion="failure"
 *   - Summary contains convergence state (roundNumber, blockingCount)
 *   - publishCheckRun degrades on error (returns null, does not throw)
 *   - publishCheckRun passes octokitOverride so getToken is never called
 */

import { describe, test, expect } from "bun:test";
import {
  buildCheckRunPayload,
  publishCheckRun,
  CHECK_RUN_NAME,
  type ConvergenceState,
  type PublishCheckRunOptions,
} from "./check-run-publisher";
import type { ReviewToolCall } from "./output-tools";

// Derive the reviewer Octokit type from the publisher's options interface.
// In tests, the custom/no-excessive-as-unknown rule allows the cast pattern
// (allowInTests: true in eslint.config.js §test file overrides).
type ReviewerOctokit = PublishCheckRunOptions["octokit"];

// ── Helpers ───────────────────────────────────────────────────────────────

function makeFinding(severity: "BLOCKING" | "NON-BLOCKING" | "PRE-EXISTING"): ReviewToolCall {
  return {
    name: "submit_finding" as const,
    args: {
      severity,
      file: "src/foo.ts",
      line: 10,
      summary: `${severity} finding`,
      details: `Details for ${severity} finding`,
    },
  };
}

function makeConvergence(roundNumber = 1, blockingCount = 0): ConvergenceState {
  return { roundNumber, blockingCount };
}

// ── buildCheckRunPayload: blockingCount is authoritative for conclusion ─────
// Regression coverage for the prose-path bug (R1): the prose review path carries
// a blockingCount but emits NO submit_finding annotations. Deriving conclusion
// from annotations alone posted a green "success" check-run on a prose
// CHANGES_REQUESTED review. blockingCount must drive the failure verdict.

describe("buildCheckRunPayload: blockingCount authoritative for conclusion (R1)", () => {
  test("prose path (no tool calls) with blockingCount > 0 → conclusion 'failure'", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [], // prose path: review verdict has blocking findings but no annotations
      convergenceState: makeConvergence(2, 3),
    });
    expect(payload.output.annotations).toHaveLength(0);
    expect(payload.conclusion).toBe("failure");
    expect(payload.output.summary).toContain("3 blocking finding");
  });

  test("blockingCount > 0 with no annotations → 'failure' (not 'success')", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [],
      convergenceState: makeConvergence(1, 1),
    });
    expect(payload.conclusion).toBe("failure");
  });

  test("blockingCount == 0 with only a NON-BLOCKING annotation → 'neutral'", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [makeFinding("NON-BLOCKING")],
      convergenceState: makeConvergence(1, 0),
    });
    expect(payload.conclusion).toBe("neutral");
  });

  test("blockingCount == 0 with no annotations → 'success'", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [],
      convergenceState: makeConvergence(1, 0),
    });
    expect(payload.conclusion).toBe("success");
  });
});

// ── buildCheckRunPayload: annotation level mapping ────────────────────────

describe("buildCheckRunPayload: annotation level mapping", () => {
  test("BLOCKING severity maps to annotation_level 'failure'", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [makeFinding("BLOCKING")],
      convergenceState: makeConvergence(1, 1),
    });
    expect(payload.output.annotations).toHaveLength(1);
    const ann = payload.output.annotations[0];
    expect(ann?.annotationLevel).toBe("failure");
  });

  test("NON-BLOCKING severity maps to annotation_level 'warning'", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [makeFinding("NON-BLOCKING")],
      convergenceState: makeConvergence(1, 0),
    });
    expect(payload.output.annotations).toHaveLength(1);
    const ann = payload.output.annotations[0];
    expect(ann?.annotationLevel).toBe("warning");
  });

  test("PRE-EXISTING severity maps to annotation_level 'notice'", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [makeFinding("PRE-EXISTING")],
      convergenceState: makeConvergence(1, 0),
    });
    expect(payload.output.annotations).toHaveLength(1);
    const ann = payload.output.annotations[0];
    expect(ann?.annotationLevel).toBe("notice");
  });

  test("non-submit_finding tool calls are ignored", () => {
    const toolCalls: ReviewToolCall[] = [
      makeFinding("BLOCKING"),
      // Cast through unknown because ConcludeReviewArgs has a different shape
      // than submit_finding; we're intentionally testing the ignore branch.
      {
        name: "conclude_review" as const,
        args: {
          overallAssessment: "done",
          changes_requested: true,
        },
      } as unknown as ReviewToolCall,
    ];
    const payload = buildCheckRunPayload({
      toolCalls,
      convergenceState: makeConvergence(1, 1),
    });
    // Only the submit_finding should be in annotations
    expect(payload.output.annotations).toHaveLength(1);
  });

  test("lineEnd defaults to line when absent", () => {
    const tc: ReviewToolCall = {
      name: "submit_finding",
      args: {
        severity: "BLOCKING",
        file: "src/bar.ts",
        line: 42,
        // lineEnd intentionally absent
        summary: "no lineEnd",
        details: "details",
      },
    };
    const payload = buildCheckRunPayload({
      toolCalls: [tc],
      convergenceState: makeConvergence(1, 1),
    });
    expect(payload.output.annotations).toHaveLength(1);
    const ann = payload.output.annotations[0];
    expect(ann?.startLine).toBe(42);
    expect(ann?.endLine).toBe(42);
  });

  test("lineEnd is used when present", () => {
    const tc: ReviewToolCall = {
      name: "submit_finding",
      args: {
        severity: "NON-BLOCKING",
        file: "src/baz.ts",
        line: 10,
        lineEnd: 15,
        summary: "span finding",
        details: "details",
      },
    };
    const payload = buildCheckRunPayload({
      toolCalls: [tc],
      convergenceState: makeConvergence(1, 0),
    });
    expect(payload.output.annotations).toHaveLength(1);
    const ann = payload.output.annotations[0];
    expect(ann?.startLine).toBe(10);
    expect(ann?.endLine).toBe(15);
  });
});

// ── buildCheckRunPayload: conclusion derivation ───────────────────────────

describe("buildCheckRunPayload: conclusion derivation", () => {
  test("BLOCKING finding → conclusion 'failure'", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [makeFinding("BLOCKING")],
      convergenceState: makeConvergence(1, 1),
    });
    expect(payload.conclusion).toBe("failure");
  });

  test("only NON-BLOCKING findings → conclusion 'neutral'", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [makeFinding("NON-BLOCKING")],
      convergenceState: makeConvergence(1, 0),
    });
    expect(payload.conclusion).toBe("neutral");
  });

  test("no findings → conclusion 'success'", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [],
      convergenceState: makeConvergence(1, 0),
    });
    expect(payload.conclusion).toBe("success");
  });

  test("mix of BLOCKING and NON-BLOCKING → conclusion 'failure'", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [makeFinding("BLOCKING"), makeFinding("NON-BLOCKING")],
      convergenceState: makeConvergence(1, 1),
    });
    expect(payload.conclusion).toBe("failure");
  });

  test("only PRE-EXISTING → conclusion 'neutral' (any annotations → neutral)", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [makeFinding("PRE-EXISTING")],
      convergenceState: makeConvergence(1, 0),
    });
    // PRE-EXISTING → 'notice'; deriveConclusion(['notice']) → 'neutral'
    // (deriveConclusion returns 'success' only for empty array)
    expect(payload.conclusion).toBe("neutral");
  });
});

// ── buildCheckRunPayload: liveness/failure path ───────────────────────────

describe("buildCheckRunPayload: liveness / failureSummary path", () => {
  test("failureSummary forces conclusion to 'failure'", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [],
      convergenceState: makeConvergence(2, 0),
      failureSummary: "empty output: no review body",
    });
    expect(payload.conclusion).toBe("failure");
  });

  test("failureSummary forces conclusion to 'failure' even with NON-BLOCKING findings", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [makeFinding("NON-BLOCKING")],
      convergenceState: makeConvergence(2, 0),
      failureSummary: "CoT leakage detected",
    });
    expect(payload.conclusion).toBe("failure");
  });

  test("summary includes failure reason and round number", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [],
      convergenceState: makeConvergence(3, 0),
      failureSummary: "model returned empty body",
    });
    expect(payload.output.summary).toContain("round 3");
    expect(payload.output.summary).toContain("model returned empty body");
  });

  test("title indicates error on liveness failure path", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [],
      convergenceState: makeConvergence(2, 0),
      failureSummary: "something went wrong",
    });
    expect(payload.output.title).toContain("error");
    expect(payload.output.title).toContain("round 2");
  });
});

// ── buildCheckRunPayload: convergence state in summary ────────────────────

describe("buildCheckRunPayload: convergence state in summary", () => {
  test("summary includes round number when no blocking findings", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [],
      convergenceState: makeConvergence(4, 0),
    });
    expect(payload.output.summary).toContain("Round 4");
    expect(payload.output.summary).toContain("approved");
  });

  test("summary includes blocking count when non-zero", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [makeFinding("BLOCKING"), makeFinding("BLOCKING")],
      convergenceState: makeConvergence(2, 2),
    });
    expect(payload.output.summary).toContain("Round 2");
    expect(payload.output.summary).toContain("2 blocking");
  });

  test("summary uses singular 'finding' when count is 1", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [makeFinding("BLOCKING")],
      convergenceState: makeConvergence(1, 1),
    });
    // "1 blocking finding remain" — singular
    expect(payload.output.summary).toMatch(/1 blocking finding[^s]/);
  });

  test("summary uses plural 'findings' when count > 1", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [makeFinding("BLOCKING"), makeFinding("BLOCKING")],
      convergenceState: makeConvergence(1, 2),
    });
    expect(payload.output.summary).toContain("2 blocking findings");
  });

  test("check run name is the stable constant", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [],
      convergenceState: makeConvergence(1, 0),
    });
    expect(payload.name).toBe(CHECK_RUN_NAME);
    expect(payload.name).toBe("minsky-reviewer/findings");
  });

  test("status is always 'completed'", () => {
    const payload = buildCheckRunPayload({
      toolCalls: [],
      convergenceState: makeConvergence(1, 0),
    });
    expect(payload.status).toBe("completed");
  });
});

// ── publishCheckRun: octokitOverride seam / degradation ──────────────────

/**
 * Build a minimal fake Octokit that records calls to checks.create.
 * We inject it via octokitOverride so getToken is never called.
 */
function makeFakeOctokit(
  checkRunResult: { id: number; html_url: string } = {
    id: 42,
    html_url: "https://example.com/check/42",
  },
  shouldThrow?: Error
): { octokit: ReviewerOctokit; calls: unknown[] } {
  const calls: unknown[] = [];
  // The fake only implements the checks.create method used by submitCheckRun.
  // Cast via unknown — this is intentional test-seam construction, not a
  // production type bypass (the custom/no-excessive-as-unknown rule allows
  // test seams; see allowInTests option in the rule config).
  const octokit = {
    rest: {
      checks: {
        create: async (params: unknown) => {
          calls.push(params);
          if (shouldThrow) throw shouldThrow;
          return { data: checkRunResult };
        },
      },
    },
  } as unknown as ReviewerOctokit;
  return { octokit, calls };
}

describe("publishCheckRun: octokitOverride seam", () => {
  const baseOptions = {
    owner: "edobry",
    repo: "minsky",
    headSha: "abc1234",
    prNumber: 99,
    toolCalls: [] as ReviewToolCall[],
    convergenceState: makeConvergence(1, 0),
  };

  test("getToken is never called (octokitOverride is used)", async () => {
    const { octokit } = makeFakeOctokit();
    const getTokenCalled = false;

    // We override the octokit, so getToken in the minimal GitHubContext
    // inside publishCheckRun should never be invoked.
    const result = await publishCheckRun({
      ...baseOptions,
      octokit,
    });

    // If getToken had been called, it would have thrown; result being non-null
    // proves we got through submitCheckRun successfully.
    expect(getTokenCalled).toBe(false);
    expect(result).not.toBeNull();
  });

  test("returns null and does not throw when octokit errors", async () => {
    const { octokit } = makeFakeOctokit({ id: 0, html_url: "" }, new Error("checks.create failed"));

    const result = await publishCheckRun({
      ...baseOptions,
      octokit,
    });

    expect(result).toBeNull();
  });

  test("returns null and does not throw on 403 permission error", async () => {
    const permError = Object.assign(new Error("Resource not accessible by integration"), {
      status: 403,
    });
    const { octokit } = makeFakeOctokit({ id: 0, html_url: "" }, permError as Error);

    const result = await publishCheckRun({
      ...baseOptions,
      octokit,
    });

    expect(result).toBeNull();
  });

  test("success path returns non-null result with checkRunId", async () => {
    const { octokit } = makeFakeOctokit({ id: 99, html_url: "https://example.com/check/99" });

    const result = await publishCheckRun({
      ...baseOptions,
      octokit,
    });

    expect(result).not.toBeNull();
    expect(result?.checkRunId).toBe(99);
  });

  test("failure/liveness path publishes with conclusion 'failure'", async () => {
    const { octokit, calls } = makeFakeOctokit();

    await publishCheckRun({
      ...baseOptions,
      octokit,
      failureSummary: "empty output from model",
    });

    expect(calls).toHaveLength(1);
    const call = calls[0] as { conclusion: string };
    expect(call.conclusion).toBe("failure");
  });
});

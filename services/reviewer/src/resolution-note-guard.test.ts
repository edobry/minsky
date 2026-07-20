import { describe, expect, test } from "bun:test";
import { evaluateSubmitFindingCall, isResolutionNoteText } from "./resolution-note-guard";
import { composeReviewBody } from "./compose-review";
import type { ReviewToolCall, SubmitFindingArgs } from "./output-tools";

function finding(overrides: Partial<SubmitFindingArgs> = {}): ReviewToolCall {
  return {
    name: "submit_finding",
    args: {
      severity: "BLOCKING",
      file: "src/foo.ts",
      line: 10,
      summary: "s",
      details: "d",
      ...overrides,
    },
  };
}

function approveConclusion(): ReviewToolCall {
  return {
    name: "conclude_review",
    args: { event: "APPROVE", summary: "No new critical defects; approving this chunk." },
  };
}

// The live PR #1957 R2 incident finding text (chunked re-verification 2/2).
const PR1957_SUMMARY = "Follow-up to the R1 block on the sanitizer wiring";
const PR1957_DETAILS =
  "No action required — the original block is resolved in the current diff. " +
  "Marking this thread for visibility.";

describe("isResolutionNoteText", () => {
  const positives: Array<[string, string]> = [
    [PR1957_SUMMARY, PR1957_DETAILS],
    ["Prior block", "no action required now that the guard was added"],
    ["Follow-up", "the original issue has been resolved in the current diff"],
    ["R1 concern", "this no longer applies after the refactor"],
    ["Retry logic", "fix verified against the reproduction"],
    ["Prior finding", "already addressed by the fix commit"],
    ["Cleanup", "nothing further to do here"],
  ];
  for (const [summary, details] of positives) {
    test(`matches resolution disposition: "${details}"`, () => {
      expect(isResolutionNoteText(summary, details)).toBe(true);
    });
  }

  const negatives: Array<[string, string]> = [
    // Imperative "must be resolved" is a genuine open defect, not a resolution note.
    ["Race condition", "this must be resolved before merge or data will be lost"],
    ["Unhandled case", "unresolved null dereference when config is missing"],
    ["Missing await", "the handler resolves the promise without awaiting it, dropping errors"],
    ["Validation gap", "requires action: the input is never bounds-checked"],
    ["Naming", "this identifier should be fixed to match the convention"],
    ["Generic defect", "off-by-one in the loop bound causes the last row to be skipped"],
    // Adversarial substrings that must NOT match thanks to word boundaries (\b).
    ["Prefix trap", "the prefix verified in this parser is computed incorrectly"],
    ["Substring trap", "the transaction is unresolved across the retry window"],
    ["Compound trap", "the manhandled buffer is addressedByOffset without validation"],
  ];
  for (const [summary, details] of negatives) {
    test(`does NOT match genuine defect: "${details}"`, () => {
      expect(isResolutionNoteText(summary, details)).toBe(false);
    });
  }
});

describe("evaluateSubmitFindingCall", () => {
  test("accepts a NON-BLOCKING finding even with resolution-note text", () => {
    const result = evaluateSubmitFindingCall({
      args: {
        severity: "NON-BLOCKING",
        file: "a.ts",
        line: 1,
        summary: PR1957_SUMMARY,
        details: PR1957_DETAILS,
      },
    });
    expect(result.decision).toBe("accept");
  });

  test("accepts a PRE-EXISTING finding even with resolution-note text", () => {
    const result = evaluateSubmitFindingCall({
      args: {
        severity: "PRE-EXISTING",
        file: "a.ts",
        line: 1,
        summary: "x",
        details: "already resolved",
      },
    });
    expect(result.decision).toBe("accept");
  });

  test("accepts a genuine BLOCKING defect unchanged (SC4)", () => {
    const result = evaluateSubmitFindingCall({
      args: {
        severity: "BLOCKING",
        file: "a.ts",
        line: 1,
        summary: "Data loss",
        details: "off-by-one in the loop bound causes the last row to be skipped",
      },
    });
    expect(result.decision).toBe("accept");
  });

  test("reclassifies a BLOCKING resolution-note finding to NON-BLOCKING", () => {
    const result = evaluateSubmitFindingCall({
      args: {
        severity: "BLOCKING",
        file: "a.ts",
        line: 1,
        summary: PR1957_SUMMARY,
        details: PR1957_DETAILS,
      },
    });
    expect(result.decision).toBe("reclassify");
    if (result.decision === "reclassify") {
      expect(result.newSeverity).toBe("NON-BLOCKING");
      expect(result.reason).toContain("mt#2863");
    }
  });

  test("is stateless — repeated calls on distinct findings do not interfere", () => {
    // Regression for the PR #2100 R1 finding: an earlier draft carried a per-review
    // rejection counter that bled across findings. The stateless guard treats each
    // call independently.
    const noteArgs: SubmitFindingArgs = {
      severity: "BLOCKING",
      file: "a.ts",
      line: 1,
      summary: PR1957_SUMMARY,
      details: PR1957_DETAILS,
    };
    const genuineArgs: SubmitFindingArgs = {
      severity: "BLOCKING",
      file: "b.ts",
      line: 2,
      summary: "Real defect",
      details: "null dereference on the empty-config path",
    };
    expect(evaluateSubmitFindingCall({ args: noteArgs }).decision).toBe("reclassify");
    expect(evaluateSubmitFindingCall({ args: genuineArgs }).decision).toBe("accept");
    expect(evaluateSubmitFindingCall({ args: noteArgs }).decision).toBe("reclassify");
  });
});

describe("PR #1957 R2 replay (SC3): guard + compose pipeline", () => {
  function effectiveSeverity(args: SubmitFindingArgs): SubmitFindingArgs["severity"] {
    const decision = evaluateSubmitFindingCall({ args });
    return decision.decision === "reclassify" ? decision.newSeverity : args.severity;
  }

  test("BEFORE fix: BLOCKING resolution-note + APPROVE reconciles to REQUEST_CHANGES (the bug)", () => {
    const toolCalls: ReviewToolCall[] = [
      finding({ severity: "BLOCKING", summary: PR1957_SUMMARY, details: PR1957_DETAILS }),
      approveConclusion(),
    ];
    const result = composeReviewBody(toolCalls);
    expect(result.event).toBe("REQUEST_CHANGES");
    expect(result.reconciled).toBe(true);
  });

  test("AFTER fix: guard reclassifies the resolution note → APPROVE, 0 blocking", () => {
    const recorded: SubmitFindingArgs = {
      severity: "BLOCKING",
      file: "src/foo.ts",
      line: 10,
      summary: PR1957_SUMMARY,
      details: PR1957_DETAILS,
    };
    const toolCalls: ReviewToolCall[] = [
      finding({
        severity: effectiveSeverity(recorded),
        summary: PR1957_SUMMARY,
        details: PR1957_DETAILS,
      }),
      approveConclusion(),
    ];
    const result = composeReviewBody(toolCalls);
    expect(result.event).toBe("APPROVE");
    expect(result.reconciled).toBe(false);
  });

  test("a genuine new BLOCKING re-verification finding still produces REQUEST_CHANGES", () => {
    const recorded: SubmitFindingArgs = {
      severity: "BLOCKING",
      file: "a.ts",
      line: 1,
      summary: "New defect introduced by the fix commit",
      details: "the retry loop now double-counts and drops the final item",
    };
    const toolCalls: ReviewToolCall[] = [
      finding({
        severity: effectiveSeverity(recorded),
        file: recorded.file,
        line: recorded.line,
        summary: recorded.summary,
        details: recorded.details,
      }),
      approveConclusion(),
    ];
    const result = composeReviewBody(toolCalls);
    expect(result.event).toBe("REQUEST_CHANGES");
    expect(result.reconciled).toBe(true);
  });
});

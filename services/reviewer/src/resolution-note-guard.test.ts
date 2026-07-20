import { describe, expect, test } from "bun:test";
import {
  evaluateSubmitFindingCall,
  isResolutionNoteText,
  DEFAULT_MAX_RESOLUTION_NOTE_REJECTIONS,
  RESOLUTION_NOTE_GUARD_CORRECTIVE_MESSAGE,
} from "./resolution-note-guard";
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
      args: finding({ severity: "NON-BLOCKING", summary: PR1957_SUMMARY, details: PR1957_DETAILS })
        .args as SubmitFindingArgs,
      rejectionCountSoFar: 0,
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
      rejectionCountSoFar: 0,
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
      rejectionCountSoFar: 0,
    });
    expect(result.decision).toBe("accept");
  });

  test("rejects a BLOCKING resolution-note finding on first attempt", () => {
    const result = evaluateSubmitFindingCall({
      args: {
        severity: "BLOCKING",
        file: "a.ts",
        line: 1,
        summary: PR1957_SUMMARY,
        details: PR1957_DETAILS,
      },
      rejectionCountSoFar: 0,
    });
    expect(result.decision).toBe("reject");
    if (result.decision === "reject") {
      expect(result.rejectionCount).toBe(1);
      expect(result.correctiveMessage).toBe(RESOLUTION_NOTE_GUARD_CORRECTIVE_MESSAGE);
    }
  });

  test("keeps rejecting up to the bound", () => {
    const result = evaluateSubmitFindingCall({
      args: {
        severity: "BLOCKING",
        file: "a.ts",
        line: 1,
        summary: PR1957_SUMMARY,
        details: PR1957_DETAILS,
      },
      rejectionCountSoFar: DEFAULT_MAX_RESOLUTION_NOTE_REJECTIONS - 1,
    });
    expect(result.decision).toBe("reject");
  });

  test("reclassifies to NON-BLOCKING once the rejection bound is exhausted", () => {
    const result = evaluateSubmitFindingCall({
      args: {
        severity: "BLOCKING",
        file: "a.ts",
        line: 1,
        summary: PR1957_SUMMARY,
        details: PR1957_DETAILS,
      },
      rejectionCountSoFar: DEFAULT_MAX_RESOLUTION_NOTE_REJECTIONS,
    });
    expect(result.decision).toBe("reclassify");
    if (result.decision === "reclassify") {
      expect(result.newSeverity).toBe("NON-BLOCKING");
      expect(result.reason).toContain("mt#2863");
    }
  });

  test("respects a custom maxRejections override", () => {
    const result = evaluateSubmitFindingCall({
      args: {
        severity: "BLOCKING",
        file: "a.ts",
        line: 1,
        summary: PR1957_SUMMARY,
        details: PR1957_DETAILS,
      },
      rejectionCountSoFar: 0,
      maxRejections: 0,
    });
    expect(result.decision).toBe("reclassify");
  });
});

describe("PR #1957 R2 replay (SC3): guard + compose pipeline", () => {
  // Apply the guard's terminal decision to a recorded finding, returning the
  // effective severity that would reach composition (reclassify on bound-exhaust).
  function effectiveSeverity(args: SubmitFindingArgs): SubmitFindingArgs["severity"] {
    const decision = evaluateSubmitFindingCall({
      args,
      rejectionCountSoFar: DEFAULT_MAX_RESOLUTION_NOTE_REJECTIONS,
    });
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
    const recorded = finding({
      severity: "BLOCKING",
      summary: PR1957_SUMMARY,
      details: PR1957_DETAILS,
    }).args as SubmitFindingArgs;
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

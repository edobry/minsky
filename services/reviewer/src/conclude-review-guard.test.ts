import { describe, expect, test } from "bun:test";
import {
  evaluateConcludeReviewCall,
  DEFAULT_MAX_CONCLUDE_REVIEW_REJECTIONS,
  CONCLUDE_REVIEW_GUARD_CORRECTIVE_MESSAGE,
} from "./conclude-review-guard";
import type { ReviewToolCall } from "./output-tools";

function blockingFinding(): ReviewToolCall {
  return {
    name: "submit_finding",
    args: {
      severity: "BLOCKING",
      file: "src/foo.ts",
      line: 1,
      summary: "s",
      details: "d",
    },
  };
}

function nonBlockingFinding(): ReviewToolCall {
  return {
    name: "submit_finding",
    args: {
      severity: "NON-BLOCKING",
      file: "src/foo.ts",
      line: 1,
      summary: "s",
      details: "d",
    },
  };
}

function preExistingFinding(): ReviewToolCall {
  return {
    name: "submit_finding",
    args: {
      severity: "PRE-EXISTING",
      file: "src/foo.ts",
      line: 1,
      summary: "s",
      details: "d",
    },
  };
}

describe("evaluateConcludeReviewCall", () => {
  test("rejects REQUEST_CHANGES with zero submit_finding calls on first attempt", () => {
    const result = evaluateConcludeReviewCall({
      args: { event: "REQUEST_CHANGES", summary: "Found issues." },
      accumulatedToolCalls: [],
      rejectionCountSoFar: 0,
    });
    expect(result.decision).toBe("reject");
    if (result.decision === "reject") {
      expect(result.rejectionCount).toBe(1);
      expect(result.correctiveMessage).toBe(CONCLUDE_REVIEW_GUARD_CORRECTIVE_MESSAGE);
    }
  });

  test("rejects again on second attempt (still under the bound)", () => {
    const result = evaluateConcludeReviewCall({
      args: { event: "REQUEST_CHANGES", summary: "Found issues." },
      accumulatedToolCalls: [],
      rejectionCountSoFar: 1,
    });
    expect(result.decision).toBe("reject");
    if (result.decision === "reject") {
      expect(result.rejectionCount).toBe(2);
    }
  });

  test("accepts with boundExhausted=true once the default bound (2) is reached", () => {
    const result = evaluateConcludeReviewCall({
      args: { event: "REQUEST_CHANGES", summary: "Found issues." },
      accumulatedToolCalls: [],
      rejectionCountSoFar: DEFAULT_MAX_CONCLUDE_REVIEW_REJECTIONS,
    });
    expect(result.decision).toBe("accept");
    if (result.decision === "accept") {
      expect(result.boundExhausted).toBe(true);
    }
  });

  test("accepts REQUEST_CHANGES when a BLOCKING finding is already recorded", () => {
    const result = evaluateConcludeReviewCall({
      args: { event: "REQUEST_CHANGES", summary: "Found issues." },
      accumulatedToolCalls: [blockingFinding()],
      rejectionCountSoFar: 0,
    });
    expect(result.decision).toBe("accept");
    if (result.decision === "accept") {
      expect(result.boundExhausted).toBe(false);
    }
  });

  test("rejects REQUEST_CHANGES when only NON-BLOCKING/PRE-EXISTING findings are recorded (no BLOCKING)", () => {
    const result = evaluateConcludeReviewCall({
      args: { event: "REQUEST_CHANGES", summary: "Found issues." },
      accumulatedToolCalls: [nonBlockingFinding(), preExistingFinding()],
      rejectionCountSoFar: 0,
    });
    expect(result.decision).toBe("reject");
  });

  test("regression: APPROVE with zero findings is always accepted, never rejected", () => {
    const result = evaluateConcludeReviewCall({
      args: { event: "APPROVE", summary: "Looks good." },
      accumulatedToolCalls: [],
      rejectionCountSoFar: 0,
    });
    expect(result.decision).toBe("accept");
    if (result.decision === "accept") {
      expect(result.boundExhausted).toBe(false);
    }
  });

  test("regression: APPROVE with zero findings is accepted even at a high rejection count", () => {
    const result = evaluateConcludeReviewCall({
      args: { event: "APPROVE", summary: "Looks good." },
      accumulatedToolCalls: [],
      rejectionCountSoFar: 10,
    });
    expect(result.decision).toBe("accept");
    if (result.decision === "accept") {
      expect(result.boundExhausted).toBe(false);
    }
  });

  test("COMMENT with zero findings is always accepted", () => {
    const result = evaluateConcludeReviewCall({
      args: { event: "COMMENT", summary: "Just observations." },
      accumulatedToolCalls: [],
      rejectionCountSoFar: 0,
    });
    expect(result.decision).toBe("accept");
    if (result.decision === "accept") {
      expect(result.boundExhausted).toBe(false);
    }
  });

  test("honors a custom maxRejections override", () => {
    const rejected = evaluateConcludeReviewCall({
      args: { event: "REQUEST_CHANGES", summary: "Found issues." },
      accumulatedToolCalls: [],
      rejectionCountSoFar: 0,
      maxRejections: 0,
    });
    // maxRejections=0 means the bound is exhausted immediately — first call accepts.
    expect(rejected.decision).toBe("accept");
    if (rejected.decision === "accept") {
      expect(rejected.boundExhausted).toBe(true);
    }
  });

  test("a BLOCKING finding recorded AFTER an earlier rejection satisfies a later call", () => {
    // Simulates the real retry flow: round 1 rejected, model emits a BLOCKING
    // finding, then re-calls conclude_review — this second call should be accepted.
    const result = evaluateConcludeReviewCall({
      args: { event: "REQUEST_CHANGES", summary: "Found issues." },
      accumulatedToolCalls: [blockingFinding()],
      rejectionCountSoFar: 1,
    });
    expect(result.decision).toBe("accept");
    if (result.decision === "accept") {
      expect(result.boundExhausted).toBe(false);
    }
  });
});

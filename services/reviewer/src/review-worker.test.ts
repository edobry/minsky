import { describe, expect, test } from "bun:test";
import { parseReviewEvent, validateReviewOutput } from "./review-worker";
import type { ReviewOutput } from "./providers";

describe("parseReviewEvent", () => {
  test("returns COMMENT when reviewer is same identity as author", () => {
    expect(parseReviewEvent("Approves cleanly.\n\nREQUEST_CHANGES", true)).toBe("COMMENT");
    expect(parseReviewEvent("APPROVE", true)).toBe("COMMENT");
  });

  test("parses REQUEST_CHANGES from tail of output", () => {
    const text = "Lots of text here.\n\nConclusion: REQUEST_CHANGES";
    expect(parseReviewEvent(text, false)).toBe("REQUEST_CHANGES");
  });

  test("parses APPROVE from tail of output", () => {
    const text = "All checks pass, clean diff.\n\nEvent: APPROVE";
    expect(parseReviewEvent(text, false)).toBe("APPROVE");
  });

  test("REQUEST_CHANGES wins over APPROVE when both appear in tail", () => {
    const text = "Some context where APPROVE appears earlier.\n\nFinal: REQUEST_CHANGES";
    expect(parseReviewEvent(text, false)).toBe("REQUEST_CHANGES");
  });

  test("defaults to COMMENT when no event marker found", () => {
    expect(parseReviewEvent("Some review text with no explicit event.", false)).toBe("COMMENT");
  });

  test("case-insensitive matching", () => {
    expect(parseReviewEvent("approve", false)).toBe("APPROVE");
    expect(parseReviewEvent("request_changes", false)).toBe("REQUEST_CHANGES");
  });

  test("only looks at the last 400 chars", () => {
    const prefix = `REQUEST_CHANGES${" filler".repeat(100)}`;
    const text = `${prefix}\n\nFinal: APPROVE`;
    // REQUEST_CHANGES is at the start, way before the 400-char window; APPROVE wins.
    expect(parseReviewEvent(text, false)).toBe("APPROVE");
  });
});

describe("validateReviewOutput", () => {
  const baseOutput: ReviewOutput = {
    text: "substantive review content",
    provider: "openai",
    model: "gpt-5",
    tokensUsed: 5000,
    usage: {
      promptTokens: 3000,
      completionTokens: 2000,
      reasoningTokens: 1500,
      totalTokens: 5000,
    },
  };

  test("passes through non-empty content", () => {
    const result = validateReviewOutput(baseOutput);
    expect(result.ok).toBe(true);
  });

  test("rejects empty-string content", () => {
    const result = validateReviewOutput({ ...baseOutput, text: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("empty content");
      expect(result.reason).toContain("openai:gpt-5");
    }
  });

  test("rejects whitespace-only content", () => {
    const result = validateReviewOutput({ ...baseOutput, text: "   \n\n  \t  " });
    expect(result.ok).toBe(false);
  });

  test("error reason includes structured token breakdown when usage is present", () => {
    const result = validateReviewOutput({ ...baseOutput, text: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("prompt=3000");
      expect(result.reason).toContain("completion=2000");
      expect(result.reason).toContain("reasoning=1500");
      expect(result.reason).toContain("total=5000");
      expect(result.reason).toContain("mt#1125");
    }
  });

  test("error reason falls back to tokensUsed when usage object missing", () => {
    const result = validateReviewOutput({
      text: "",
      provider: "openai",
      model: "gpt-5",
      tokensUsed: 8192,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("tokensUsed=8192");
    }
  });

  test("substantive content passes even when usage indicates heavy reasoning", () => {
    const result = validateReviewOutput({
      ...baseOutput,
      text: "some content",
      usage: {
        promptTokens: 3000,
        completionTokens: 50,
        reasoningTokens: 7000,
        totalTokens: 10050,
      },
    });
    expect(result.ok).toBe(true);
  });
});

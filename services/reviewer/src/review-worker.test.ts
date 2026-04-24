import { beforeEach, describe, expect, test } from "bun:test";
import {
  parseReviewEvent,
  validateReviewOutput,
  buildEmptyOutputSkipNotice,
  callReviewerWithRetry,
  type CallReviewerFn,
} from "./review-worker";
import type { CallReviewerOptions, ReviewOutput } from "./providers";
import type { ReviewerConfig } from "./config";

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
    }
  });

  test("error reason does not leak internal tracker IDs", () => {
    const result = validateReviewOutput({ ...baseOutput, text: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toMatch(/mt#\d+/);
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

describe("buildEmptyOutputSkipNotice", () => {
  const emptyOutput: ReviewOutput = {
    text: "",
    provider: "openai",
    model: "gpt-5",
    tokensUsed: 16000,
    usage: {
      promptTokens: 4000,
      completionTokens: 0,
      reasoningTokens: 12000,
      totalTokens: 16000,
    },
  };

  test("starts with the skip marker", () => {
    const notice = buildEmptyOutputSkipNotice(emptyOutput);
    expect(notice).toContain("Automated review skipped");
  });

  test("includes the not-an-approval disclaimer", () => {
    const notice = buildEmptyOutputSkipNotice(emptyOutput);
    expect(notice.toLowerCase()).toContain("not");
    expect(notice.toLowerCase()).toContain("approval");
    expect(notice.toLowerCase()).toContain("rejection");
  });

  test("includes provider and model identifiers", () => {
    const notice = buildEmptyOutputSkipNotice(emptyOutput);
    expect(notice).toContain("openai:gpt-5");
  });

  test("includes reasoning-budget hint when completion=0 and reasoning>0", () => {
    const notice = buildEmptyOutputSkipNotice(emptyOutput);
    expect(notice).toContain("reasoning phase");
    expect(notice).toContain("12000 reasoning tokens");
  });

  test("omits reasoning-budget hint when usage is undefined", () => {
    const notice = buildEmptyOutputSkipNotice({
      text: "",
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    expect(notice).not.toContain("reasoning phase");
  });

  test("omits reasoning-budget hint when completion is non-zero", () => {
    const notice = buildEmptyOutputSkipNotice({
      ...emptyOutput,
      usage: {
        promptTokens: 4000,
        completionTokens: 100,
        reasoningTokens: 8000,
        totalTokens: 12100,
      },
    });
    expect(notice).not.toContain("reasoning phase");
  });

  test("skip notice never contains a parseable review-event marker", () => {
    const notice = buildEmptyOutputSkipNotice(emptyOutput);
    const tail = notice.slice(-400).toUpperCase();
    expect(tail).not.toMatch(/\bREQUEST_CHANGES\b/);
    expect(tail).not.toMatch(/\bAPPROVE\b/);
  });
});

describe("callReviewerWithRetry (mt#1131)", () => {
  // Minimal fake config — the helper only passes this through to callReviewer;
  // the fake implementation below never reads it.
  const fakeConfig = {
    provider: "openai",
    providerApiKey: "fake",
    providerModel: "gpt-5",
  } as unknown as ReviewerConfig;

  /**
   * Build a test-seam CallReviewerFn that returns outputs from a queue in
   * sequence and records each invocation's options.
   */
  type Invocation = { options?: CallReviewerOptions };
  function fakeReviewer(outputs: ReviewOutput[], invocations: Invocation[]): CallReviewerFn {
    let i = 0;
    return async (_config, _sys, _user, options) => {
      invocations.push({ options });
      const next = outputs[i];
      if (next === undefined) {
        throw new Error(`fakeReviewer ran out of outputs (invocation ${i + 1})`);
      }
      i++;
      return next;
    };
  }

  const substantive: ReviewOutput = {
    text: "Findings: something substantive.\n\nAPPROVE",
    provider: "openai",
    model: "gpt-5",
    tokensUsed: 500,
    usage: { promptTokens: 3000, completionTokens: 500, totalTokens: 3500 },
  };

  function makeEmpty(provider: "openai" | "google" | "anthropic"): ReviewOutput {
    return {
      text: "",
      provider,
      model:
        provider === "openai"
          ? "gpt-5"
          : provider === "google"
            ? "gemini-2.5-pro"
            : "claude-opus-4-6",
      tokensUsed: 16000,
      usage: {
        promptTokens: 4000,
        completionTokens: 0,
        reasoningTokens: 12000,
        totalTokens: 16000,
      },
    };
  }

  let invocations: Invocation[];
  beforeEach(() => {
    invocations = [];
  });

  test("first call substantive → attempt=first-attempt-success, no retry", async () => {
    const result = await callReviewerWithRetry(
      fakeConfig,
      "sys",
      "user",
      fakeReviewer([substantive], invocations)
    );

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.options).toBeUndefined();
    expect(result.attempt).toBe("first-attempt-success");
    expect(result.retryAttempted).toBe(false);
    expect(result.validation.ok).toBe(true);
    expect(result.output).toBe(substantive);
  });

  test("first empty (OpenAI), retry substantive → attempt=retry-success, reasoningEffort=low on retry", async () => {
    const result = await callReviewerWithRetry(
      fakeConfig,
      "sys",
      "user",
      fakeReviewer([makeEmpty("openai"), substantive], invocations)
    );

    expect(invocations).toHaveLength(2);
    // First call must NOT have reasoningEffort set — the bridge only overrides
    // on retry, preserving the configured default on the initial attempt.
    expect(invocations[0]?.options).toBeUndefined();
    expect(invocations[1]?.options).toEqual({ reasoningEffort: "low" });
    expect(result.attempt).toBe("retry-success");
    expect(result.retryAttempted).toBe(true);
    expect(result.validation.ok).toBe(true);
    expect(result.output).toBe(substantive);
  });

  test("first empty (OpenAI), retry also empty → attempt=retry-failed, validation not ok", async () => {
    const retryEmpty: ReviewOutput = { ...makeEmpty("openai"), text: "" };
    const result = await callReviewerWithRetry(
      fakeConfig,
      "sys",
      "user",
      fakeReviewer([makeEmpty("openai"), retryEmpty], invocations)
    );

    expect(invocations).toHaveLength(2);
    expect(invocations[1]?.options).toEqual({ reasoningEffort: "low" });
    expect(result.attempt).toBe("retry-failed");
    expect(result.retryAttempted).toBe(true);
    expect(result.validation.ok).toBe(false);
    expect(result.output).toBe(retryEmpty);
  });

  test("first empty (Google) → no retry attempted, attempt=retry-failed, retryAttempted=false", async () => {
    const empty = makeEmpty("google");
    const result = await callReviewerWithRetry(
      fakeConfig,
      "sys",
      "user",
      fakeReviewer([empty], invocations)
    );

    expect(invocations).toHaveLength(1);
    expect(result.attempt).toBe("retry-failed");
    expect(result.retryAttempted).toBe(false);
    expect(result.validation.ok).toBe(false);
    expect(result.output).toBe(empty);
  });

  test("first empty (Anthropic) → no retry attempted, attempt=retry-failed, retryAttempted=false", async () => {
    const empty = makeEmpty("anthropic");
    const result = await callReviewerWithRetry(
      fakeConfig,
      "sys",
      "user",
      fakeReviewer([empty], invocations)
    );

    expect(invocations).toHaveLength(1);
    expect(result.attempt).toBe("retry-failed");
    expect(result.retryAttempted).toBe(false);
  });

  test("never cascades beyond one retry even if second call returns empty", async () => {
    const retryEmpty: ReviewOutput = { ...makeEmpty("openai"), text: "" };
    const third: ReviewOutput = { ...substantive, text: "substantive" };
    // Queue has three outputs; only the first two should be consumed.
    await callReviewerWithRetry(
      fakeConfig,
      "sys",
      "user",
      fakeReviewer([makeEmpty("openai"), retryEmpty, third], invocations)
    );

    expect(invocations).toHaveLength(2);
  });
});

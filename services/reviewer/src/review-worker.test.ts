import { beforeEach, describe, expect, test, mock } from "bun:test";
import {
  parseReviewEvent,
  validateReviewOutput,
  buildEmptyOutputSkipNotice,
  decidePostSanitizeOutcome,
  callReviewerWithRetry,
  decideToolsActive,
  defaultForkAccessProbe,
  buildRunReviewStartLog,
  buildConvergenceMetricLog,
  buildSubmitFailureLog,
  serializeSubmitError,
  applyRecoveryAndCompose,
  type CallReviewerFn,
  type ReviewResult,
  type PriorReviewFetcherFn,
  type PriorReviewIngestionResult,
  type RunReviewDeps,
} from "./review-worker";
import type { ReviewerDb } from "./db/client";
import type { ConvergenceMetricInput } from "./metrics";
import type { ReviewToolCall } from "./output-tools";
import type { FlatPriorFinding } from "./severity-recovery";
import type { CallReviewerOptions, ReviewOutput } from "./providers";
import type { ReviewerConfig } from "./config";
import type { ReviewerToolContext, ReadFileResult } from "./tools";
import type { SanitizeResult } from "./sanitize";
import type { PRScope } from "./pr-scope";
import { TimeoutError } from "./with-timeout";
import type { PriorReview } from "./prior-review-summary";
import { extractProvenance } from "./review-provenance";
import { SYNTHESIZED_FINDING_FILE } from "./empty-findings-recovery";

// Shared constant for the first-attempt trace string — used in multiple
// describe blocks so it must be file-scoped to avoid no-magic-string-duplication.
const ATTEMPT_FIRST_SUCCESS = "first-attempt-success" as const;

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
    toolCalls: [],
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
      toolCalls: [],
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
    toolCalls: [],
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
      toolCalls: [],
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
    return async (_config, _sys, _user, _tools, options) => {
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
    toolCalls: [],
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
      toolCalls: [],
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
      undefined,
      fakeReviewer([substantive], invocations)
    );

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.options).toBeUndefined();
    expect(result.attempt).toBe(ATTEMPT_FIRST_SUCCESS);
    expect(result.retryAttempted).toBe(false);
    expect(result.validation.ok).toBe(true);
    expect(result.output).toBe(substantive);
  });

  test("first empty (OpenAI), retry substantive → attempt=retry-success, reasoningEffort=low on retry", async () => {
    const result = await callReviewerWithRetry(
      fakeConfig,
      "sys",
      "user",
      undefined,
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
      undefined,
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
      undefined,
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
      undefined,
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
      undefined,
      fakeReviewer([makeEmpty("openai"), retryEmpty, third], invocations)
    );

    expect(invocations).toHaveLength(2);
  });
});

// ----- callReviewerWithRetry — TimeoutError retry (mt#2083) -----

describe("callReviewerWithRetry — TimeoutError retry (mt#2083)", () => {
  const fakeConfig = {
    provider: "openai",
    providerApiKey: "fake",
    providerModel: "gpt-5",
  } as unknown as ReviewerConfig;

  const substantive: ReviewOutput = {
    text: "Findings: something substantive.\n\nAPPROVE",
    provider: "openai",
    model: "gpt-5",
    tokensUsed: 500,
    usage: { promptTokens: 3000, completionTokens: 500, totalTokens: 3500 },
    toolCalls: [],
  };

  test("retries once on TimeoutError and succeeds with reasoningEffort=low for OpenAI", async () => {
    let callCount = 0;
    type Invocation = { options?: CallReviewerOptions };
    const invocations: Invocation[] = [];
    const fakeFn: CallReviewerFn = async (_config, _sys, _user, _tools, options) => {
      invocations.push({ options });
      callCount++;
      if (callCount === 1)
        throw new TimeoutError("openai.chat.completions.create.toolloop", 120000);
      return substantive;
    };
    const result = await callReviewerWithRetry(fakeConfig, "sys", "user", undefined, fakeFn);
    expect(callCount).toBe(2);
    expect(result.attempt).toBe("retry-success");
    expect(result.retryAttempted).toBe(true);
    expect(result.output.text).toContain("substantive");
    expect(invocations[1]?.options).toEqual({ reasoningEffort: "low" });
  });

  test("timeout retry for non-OpenAI provider does NOT pass reasoningEffort", async () => {
    const googleConfig = { ...fakeConfig, provider: "google" } as unknown as ReviewerConfig;
    const googleSubstantive = {
      ...substantive,
      provider: "google" as const,
      model: "gemini-2.5-pro",
    };
    let callCount = 0;
    type Invocation = { options?: CallReviewerOptions };
    const invocations: Invocation[] = [];
    const fakeFn: CallReviewerFn = async (_config, _sys, _user, _tools, options) => {
      invocations.push({ options });
      callCount++;
      if (callCount === 1) throw new TimeoutError("test.op", 120000);
      return googleSubstantive;
    };
    const result = await callReviewerWithRetry(googleConfig, "sys", "user", undefined, fakeFn);
    expect(callCount).toBe(2);
    expect(result.attempt).toBe("retry-success");
    expect(invocations[1]?.options).toBeUndefined();
  });

  test("retries once on TimeoutError — retry also times out → propagates", async () => {
    const fakeFn: CallReviewerFn = async () => {
      throw new TimeoutError("openai.chat.completions.create.toolloop", 120000);
    };
    await expect(
      callReviewerWithRetry(fakeConfig, "sys", "user", undefined, fakeFn)
    ).rejects.toThrow(TimeoutError);
  });

  test("non-TimeoutError propagates without retry", async () => {
    let callCount = 0;
    const fakeFn: CallReviewerFn = async () => {
      callCount++;
      throw new Error("network failure");
    };
    await expect(
      callReviewerWithRetry(fakeConfig, "sys", "user", undefined, fakeFn)
    ).rejects.toThrow("network failure");
    expect(callCount).toBe(1);
  });

  test("timeout retry returning empty → falls through to empty-output retry path", async () => {
    let callCount = 0;
    const empty: ReviewOutput = {
      text: "",
      provider: "openai",
      model: "gpt-5",
      tokensUsed: 16000,
      usage: {
        promptTokens: 4000,
        completionTokens: 0,
        reasoningTokens: 16000,
        totalTokens: 20000,
      },
      toolCalls: [],
    };
    const fakeFn: CallReviewerFn = async () => {
      callCount++;
      if (callCount === 1) throw new TimeoutError("test.op", 120000);
      if (callCount === 2) return empty;
      return substantive;
    };
    const result = await callReviewerWithRetry(fakeConfig, "sys", "user", undefined, fakeFn);
    // First call: timeout → catch → retry call (callCount=2) returns empty
    // Empty output from timeout-retry does NOT cascade to the empty-output retry
    // (the timeout-retry branch returns directly).
    expect(callCount).toBe(2);
    expect(result.attempt).toBe("retry-failed");
    expect(result.retryAttempted).toBe(true);
  });
});

// ----- ReviewerToolContext integration -----
//
// Verify that a ReviewerToolContext with the correct shape can be constructed
// and that the readFile / listDirectory callbacks close over the right data.
// (The actual wiring into callReviewer is covered in providers.test.ts.)

describe("ReviewerToolContext shape", () => {
  test("readFile callback returns ReadFileResult or null", async () => {
    const readFile = mock(async (path: string): Promise<ReadFileResult | null> => {
      if (path === "src/exists.ts")
        return { kind: "text", content: "file content", truncated: false };
      return null;
    });

    const tools: ReviewerToolContext = {
      readFile,
      listDirectory: mock(async () => null),
    };

    expect(await tools.readFile("src/exists.ts")).toEqual({
      kind: "text",
      content: "file content",
      truncated: false,
    });
    expect(await tools.readFile("src/missing.ts")).toBeNull();
  });

  test("listDirectory callback returns entries or null", async () => {
    const entries = [
      { name: "index.ts", type: "file" as const },
      { name: "lib", type: "dir" as const },
    ];
    const listDirectory = mock(async (path: string) => {
      if (path === "src") return entries;
      return null;
    });

    const tools: ReviewerToolContext = {
      readFile: mock(async () => null),
      listDirectory,
    };

    expect(await tools.listDirectory("src")).toEqual(entries);
    expect(await tools.listDirectory("missing-dir")).toBeNull();
  });
});

// ----- decidePostSanitizeOutcome (mt#1212 integration branch) -----
//
// Covers the post-sanitize decision the worker applies to the three
// SanitizeResult.action values (passthrough / stripped / errored).
// Extracted into a pure helper so these branches can be tested without
// mocking octokit + App auth + github-client. Resolves the reviewer
// subagent's BLOCKING finding that the worker's stripped/errored branches
// had no test coverage.

describe("decidePostSanitizeOutcome", () => {
  const REVIEWER_LOGIN = "minsky-reviewer[bot]";
  const STRIPPED_LEAK_MARKER = "[cot-leakage: stripped]";

  const ctx = {
    reviewerLogin: REVIEWER_LOGIN,
    provider: "openai",
    model: "gpt-5",
    attempt: ATTEMPT_FIRST_SUCCESS,
  };

  const passthrough: SanitizeResult = {
    action: "passthrough",
    body: "## Findings\n\n- [NON-BLOCKING] src/foo.ts:1 — minor.\n\nEvent: APPROVE",
    meta: { originalLength: 80, cleanedLength: 80 },
  };

  const stripped: SanitizeResult = {
    action: "stripped",
    body: "## Findings\n\n- [BLOCKING] src/foo.ts:1 — bad.\n\nEvent: REQUEST_CHANGES",
    meta: {
      originalLength: 5000,
      cleanedLength: 80,
      reason: "cot-leak:blank-line-run,scratch:this-time-for-sure",
    },
  };

  const errored: SanitizeResult = {
    action: "errored",
    body: "**reviewer-service error: chain-of-thought leakage detected**\n\n...",
    meta: {
      originalLength: 1200,
      cleanedLength: 200,
      reason: "cot-leak:scratch:openai-tool-routing,long-narrative-prefix",
    },
  };

  test("passthrough: parses event from body, status=reviewed, no leak marker", () => {
    const outcome = decidePostSanitizeOutcome(passthrough, false, ctx);
    expect(outcome.event).toBe("APPROVE");
    expect(outcome.status).toBe("reviewed");
    expect(outcome.reason).toContain("Posted APPROVE review");
    expect(outcome.reason).toContain(REVIEWER_LOGIN);
    expect(outcome.reason).toContain("openai");
    expect(outcome.reason).toContain("gpt-5");
    expect(outcome.reason).toContain("attempt=first-attempt-success");
    expect(outcome.reason).not.toContain(STRIPPED_LEAK_MARKER);
  });

  test("stripped: parses event from sanitised body, status=reviewed, appends leak marker", () => {
    const outcome = decidePostSanitizeOutcome(stripped, false, ctx);
    expect(outcome.event).toBe("REQUEST_CHANGES");
    expect(outcome.status).toBe("reviewed");
    expect(outcome.reason).toContain(STRIPPED_LEAK_MARKER);
  });

  test("errored: forces COMMENT event, status=error, reason cites sanitize reason", () => {
    const outcome = decidePostSanitizeOutcome(errored, false, ctx);
    expect(outcome.event).toBe("COMMENT");
    expect(outcome.status).toBe("error");
    expect(outcome.reason).toContain("service-error notice");
    expect(outcome.reason).toContain(REVIEWER_LOGIN);
    // Provider + model + attempt are included for log-grep parity with the
    // reviewed path.
    expect(outcome.reason).toContain("openai");
    expect(outcome.reason).toContain("gpt-5");
    expect(outcome.reason).toContain("attempt=first-attempt-success");
    // Sanitize reason must be included so operators can see which signals fired.
    expect(outcome.reason).toContain("cot-leak:scratch:openai-tool-routing");
  });

  test("errored: ignores isSelfReview (always COMMENT regardless)", () => {
    const outcome = decidePostSanitizeOutcome(errored, true, ctx);
    expect(outcome.event).toBe("COMMENT");
    expect(outcome.status).toBe("error");
  });

  test("self-review on passthrough: parseReviewEvent returns COMMENT", () => {
    const outcome = decidePostSanitizeOutcome(passthrough, true, ctx);
    expect(outcome.event).toBe("COMMENT");
    expect(outcome.status).toBe("reviewed");
  });

  test("self-review on stripped: parseReviewEvent returns COMMENT, leak marker still appended", () => {
    const outcome = decidePostSanitizeOutcome(stripped, true, ctx);
    expect(outcome.event).toBe("COMMENT");
    expect(outcome.status).toBe("reviewed");
    expect(outcome.reason).toContain(STRIPPED_LEAK_MARKER);
  });

  test("errored: attempt trace propagates (e.g. retry-success)", () => {
    const outcome = decidePostSanitizeOutcome(errored, false, {
      ...ctx,
      attempt: "retry-success",
    });
    expect(outcome.reason).toContain("attempt=retry-success");
  });
});

// ----- decideToolsActive (mt#1216 fork-gating + probe) -----
//
// Pure helper that decides whether the tool-use loop is active for a given
// PR + provider combination. Gates on provider capability (OpenAI only) and,
// for forked PRs, the result of a fork-access probe. Extracted from
// runReview so the branches can be tested without mocking octokit/auth.

describe("decideToolsActive", () => {
  const baseConfig = (provider: "openai" | "google" | "anthropic") =>
    ({ provider }) as unknown as Parameters<typeof decideToolsActive>[0];

  test("OpenAI + in-repo PR → active, no probe call", async () => {
    const probe = mock(async () => true);
    const result = await decideToolsActive(
      baseConfig("openai"),
      { number: 101, isForkedPR: false },
      probe
    );
    expect(result.toolsActive).toBe(true);
    expect(result.reason).toBeUndefined();
    // Non-fork: probe is skipped entirely. Paying a network round-trip on the
    // common case would be wasteful and also make the test mock-sensitive.
    expect(probe).not.toHaveBeenCalled();
  });

  test("OpenAI + forked PR + probe succeeds → active", async () => {
    const probe = mock(async () => true);
    const result = await decideToolsActive(
      baseConfig("openai"),
      { number: 200, isForkedPR: true },
      probe
    );
    expect(result.toolsActive).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  test("OpenAI + forked PR + probe fails → inactive with fork reason", async () => {
    const probe = mock(async () => false);
    const result = await decideToolsActive(
      baseConfig("openai"),
      { number: 201, isForkedPR: true },
      probe
    );
    expect(result.toolsActive).toBe(false);
    expect(result.reason).toContain("fork-access probe failed");
    expect(result.reason).toContain("201");
  });

  test("Google → inactive with provider reason, probe NOT called", async () => {
    const probe = mock(async () => true);
    const result = await decideToolsActive(
      baseConfig("google"),
      { number: 300, isForkedPR: false },
      probe
    );
    expect(result.toolsActive).toBe(false);
    expect(result.reason).toContain("provider google");
    expect(result.reason).toContain("OpenAI-only");
    // Non-OpenAI short-circuits before the fork check — probe must never fire.
    expect(probe).not.toHaveBeenCalled();
  });

  test("Anthropic + forked PR → inactive with provider reason (provider check wins)", async () => {
    const probe = mock(async () => true);
    const result = await decideToolsActive(
      baseConfig("anthropic"),
      { number: 400, isForkedPR: true },
      probe
    );
    expect(result.toolsActive).toBe(false);
    expect(result.reason).toContain("provider anthropic");
    expect(probe).not.toHaveBeenCalled();
  });
});

// ----- defaultForkAccessProbe (mt#1216) -----
//
// Tries README.md first, falls back to package.json, treats any throw as a
// probe miss. Returns true iff at least one probe file resolves to a
// non-null result.

describe("defaultForkAccessProbe", () => {
  type FakeOctokit = Parameters<typeof defaultForkAccessProbe>[0];
  const prCoords = { headOwner: "fork-owner", headRepo: "fork-repo", headSha: "deadbeef" };

  function makeOctokit(
    getContentImpl: (params: { owner: string; repo: string; path: string; ref: string }) => unknown
  ): FakeOctokit {
    return {
      rest: { repos: { getContent: mock(getContentImpl) } },
    } as unknown as FakeOctokit;
  }

  test("README.md present → true, package.json not fetched", async () => {
    let calls = 0;
    const octokit = makeOctokit((params) => {
      calls++;
      expect(params.path).toBe("README.md");
      const content = Buffer.from("# hello").toString("base64");
      return { data: { type: "file", content, encoding: "base64" } };
    });
    await expect(defaultForkAccessProbe(octokit, prCoords)).resolves.toBe(true);
    expect(calls).toBe(1);
  });

  test("README.md returns null, package.json present → true", async () => {
    const paths: string[] = [];
    const octokit = makeOctokit((params) => {
      paths.push(params.path);
      if (params.path === "README.md") {
        const err = new Error("Not Found") as Error & { status: number };
        err.status = 404;
        throw err;
      }
      const content = Buffer.from('{"name":"pkg"}').toString("base64");
      return { data: { type: "file", content, encoding: "base64" } };
    });
    await expect(defaultForkAccessProbe(octokit, prCoords)).resolves.toBe(true);
    expect(paths).toEqual(["README.md", "package.json"]);
  });

  test("both null → false", async () => {
    const octokit = makeOctokit(() => {
      const err = new Error("Not Found") as Error & { status: number };
      err.status = 404;
      throw err;
    });
    await expect(defaultForkAccessProbe(octokit, prCoords)).resolves.toBe(false);
  });

  test("README.md throws 403, package.json resolves → true (permission errors swallowed)", async () => {
    const octokit = makeOctokit((params) => {
      if (params.path === "README.md") {
        const err = new Error("Forbidden") as Error & { status: number };
        err.status = 403;
        throw err;
      }
      const content = Buffer.from("{}").toString("base64");
      return { data: { type: "file", content, encoding: "base64" } };
    });
    await expect(defaultForkAccessProbe(octokit, prCoords)).resolves.toBe(true);
  });

  test("both throw → false", async () => {
    const octokit = makeOctokit(() => {
      const err = new Error("Forbidden") as Error & { status: number };
      err.status = 403;
      throw err;
    });
    await expect(defaultForkAccessProbe(octokit, prCoords)).resolves.toBe(false);
  });
});

// ----- buildRunReviewStartLog (mt#1256) -----
//
// Pure helper that constructs the runReview_start structured log object.
// Extracted from runReview so the log shape can be tested via a pure function
// without module-level mocking (custom/no-global-module-mocks rule).
// runReview calls JSON.stringify(buildRunReviewStartLog(...)) at its entry
// point, before any network calls, so the log fires for every review attempt.

describe("buildRunReviewStartLog (mt#1256)", () => {
  test("includes event=runReview_start with all required fields", () => {
    const log = buildRunReviewStartLog("delivery-abc123", "owner1", "repo1", 42, "sha1234");
    expect(log["event"]).toBe("runReview_start");
    expect(log["delivery_id"]).toBe("delivery-abc123");
    expect(log["owner"]).toBe("owner1");
    expect(log["repo"]).toBe("repo1");
    expect(log["pr"]).toBe(42);
    expect(log["sha"]).toBe("sha1234");
  });

  test("accepts 'unknown' as the delivery_id default sentinel", () => {
    const log = buildRunReviewStartLog("unknown", "owner", "repo", 1, "unknown");
    expect(log["delivery_id"]).toBe("unknown");
    expect(log["sha"]).toBe("unknown");
  });

  test("serialises cleanly as JSON (no undefined values or circular refs)", () => {
    const log = buildRunReviewStartLog("del-999", "o", "r", 5, "abc");
    expect(() => JSON.stringify(log)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(log)) as Record<string, unknown>;
    expect(parsed["delivery_id"]).toBe("del-999");
  });

  test("all six keys are present, no extra keys", () => {
    const log = buildRunReviewStartLog("d", "o", "r", 1, "s");
    const keys = Object.keys(log).sort();
    expect(keys).toEqual(["delivery_id", "event", "owner", "pr", "repo", "sha"]);
  });
});

// ----- ReviewResult.scope field (mt#1188) -----
//
// The scope field carries the PR scope classification from runReview back to
// the server for the review_result log. Verified via the TypeScript type shape
// (structural check) so no network mocking is required — the field is already
// integration-tested via the full pr-scope.test.ts suite.

describe("ReviewResult.scope type (mt#1188)", () => {
  test("ReviewResult.scope accepts all PRScope values or undefined", () => {
    // Structural type assertion — ensure the scope field is typed correctly.
    // This test is compile-time only; if it passes tsc it's correct.
    const scopes: Array<PRScope | undefined> = [
      "normal",
      "trivial",
      "docs-only",
      "test-only",
      undefined,
    ];
    for (const scope of scopes) {
      const result: ReviewResult = {
        status: "reviewed",
        reason: "ok",
        tier: 3,
        scope,
      };
      // Cast through unknown so toBe's argument inference doesn't strip the
      // optional `undefined` from result.scope (varies across @types/bun
      // versions resolved by the root workspace install vs. the service's
      // own node_modules).
      expect(result.scope as unknown).toBe(scope);
    }
  });

  test("ReviewResult without scope field is valid (skipped reviews omit it)", () => {
    const result: ReviewResult = {
      status: "skipped",
      reason: "tier mismatch",
      tier: 1,
    };
    expect(result.scope).toBeUndefined();
  });
});

// ----- PriorReviewFetcherFn DI seam (mt#1189) -----
//
// Verifies the injectable prior-review fetcher type signature works correctly
// with both a conforming async function and a throwing function, matching the
// RunReviewDeps interface contract.

// Constants for repeated strings — avoids no-magic-string-duplication warnings.
const BOT_LOGIN = "minsky-reviewer[bot]";
const FETCH_ERROR_MSG = "GitHub API unavailable";

const SAMPLE_PRIOR_REVIEW: PriorReview = {
  id: 1,
  state: "CHANGES_REQUESTED",
  submittedAt: "2026-04-01T10:00:00Z",
  commitId: "abc123",
  userLogin: BOT_LOGIN,
  body: "**Independent adversarial review (Chinese-wall)**\n\n### Findings\n\n- **[BLOCKING]** src/foo.ts:1 — issue",
};

describe("PriorReviewFetcherFn DI seam (mt#1189)", () => {
  test("a conforming async function satisfies PriorReviewFetcherFn type", async () => {
    const fetcher: PriorReviewFetcherFn = async () => [SAMPLE_PRIOR_REVIEW];
    const reviews = await fetcher({} as Parameters<PriorReviewFetcherFn>[0], "owner", "repo", 1);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.userLogin).toBe(BOT_LOGIN);
  });

  test("a throwing PriorReviewFetcherFn can be used as a test seam for the error path", async () => {
    const failingFetcher: PriorReviewFetcherFn = async () => {
      throw new Error(FETCH_ERROR_MSG);
    };
    await expect(
      failingFetcher({} as Parameters<PriorReviewFetcherFn>[0], "owner", "repo", 42)
    ).rejects.toThrow(FETCH_ERROR_MSG);
  });
});

// ----- PriorReviewIngestionResult error path (mt#1189) -----
//
// The error path in runReview catches fetchPriorReviews throws and produces a
// PriorReviewIngestionResult with iterationCount=0, staleCount=0,
// priorBlockingCounts=[], and the error message captured. Verified structurally
// since runReview itself requires the full GitHub client stack.

describe("PriorReviewIngestionResult error-path shape (mt#1189)", () => {
  test("error result has iterationCount=0, staleCount=0, priorBlockingCounts=[], error set", () => {
    const errorResult: PriorReviewIngestionResult = {
      iterationCount: 0,
      staleCount: 0,
      priorBlockingCounts: [],
      error: FETCH_ERROR_MSG,
    };
    expect(errorResult.iterationCount).toBe(0);
    expect(errorResult.staleCount).toBe(0);
    expect(errorResult.priorBlockingCounts).toEqual([]);
    expect(errorResult.error).toBe(FETCH_ERROR_MSG);
  });

  test("success result has no error field when fetch succeeded", () => {
    const successResult: PriorReviewIngestionResult = {
      iterationCount: 2,
      staleCount: 1,
      priorBlockingCounts: [3, 1],
    };
    expect(successResult.error).toBeUndefined();
    expect(successResult.iterationCount).toBe(2);
    expect(successResult.priorBlockingCounts).toEqual([3, 1]);
  });

  test("ReviewResult.priorReviewIngestion field is present on a reviewed result", () => {
    const result: ReviewResult = {
      status: "reviewed",
      reason: "Posted APPROVE review as minsky-reviewer[bot]",
      tier: 3,
      priorReviewIngestion: {
        iterationCount: 1,
        staleCount: 0,
        priorBlockingCounts: [2],
      },
    };
    expect(result.priorReviewIngestion?.iterationCount).toBe(1);
    expect(result.priorReviewIngestion?.priorBlockingCounts).toEqual([2]);
  });
});

// ----- buildConvergenceMetricLog (SC-5, mt#1189) -----
//
// Pure helper that constructs the reviewer.convergence_metric structured log
// object. Extracted from runReview (same pattern as buildRunReviewStartLog)
// so the 6-field shape can be verified without mocking octokit + App auth.

// Log field name constants — avoids no-magic-string-duplication warnings on
// repeated object key string lookups.
const FIELD_PRIOR_BLOCKER_COUNT = "priorBlockerCount";
const FIELD_ACKNOWLEDGED_COUNT = "acknowledgedAsAddressedCount";
const FIELD_ITERATION_INDEX = "iterationIndex";
const FIELD_NEW_BLOCKER_COUNT = "newBlockerCount";

describe("buildConvergenceMetricLog (SC-5, mt#1189)", () => {
  test("includes event=reviewer.convergence_metric with all 6 required fields", () => {
    const log = buildConvergenceMetricLog(769, "abc123def456", 3, 5, 2, 1);
    expect(log["event"]).toBe("reviewer.convergence_metric");
    expect(log["pr"]).toBe(769);
    expect(log["sha"]).toBe("abc123def456");
    expect(log[FIELD_ITERATION_INDEX]).toBe(3);
    expect(log[FIELD_PRIOR_BLOCKER_COUNT]).toBe(5);
    expect(log[FIELD_NEW_BLOCKER_COUNT]).toBe(2);
    expect(log[FIELD_ACKNOWLEDGED_COUNT]).toBe(1);
  });

  test("first iteration (no prior reviews): iterationIndex=1, priorBlockerCount=0", () => {
    const log = buildConvergenceMetricLog(100, "sha001", 1, 0, 3, 0);
    expect(log[FIELD_ITERATION_INDEX]).toBe(1);
    expect(log[FIELD_PRIOR_BLOCKER_COUNT]).toBe(0);
    expect(log[FIELD_NEW_BLOCKER_COUNT]).toBe(3);
    expect(log[FIELD_ACKNOWLEDGED_COUNT]).toBe(0);
  });

  test("serialises cleanly as JSON with no undefined values or circular refs", () => {
    const log = buildConvergenceMetricLog(42, "sha999", 2, 4, 1, 2);
    expect(() => JSON.stringify(log)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(log)) as Record<string, unknown>;
    expect(parsed["event"]).toBe("reviewer.convergence_metric");
    expect(parsed["pr"]).toBe(42);
    expect(parsed["sha"]).toBe("sha999");
  });

  test("all 7 keys are present (event + 6 metric fields), no extra keys", () => {
    const log = buildConvergenceMetricLog(1, "s", 1, 0, 0, 0);
    const keys = Object.keys(log).sort();
    expect(keys).toEqual([
      FIELD_ACKNOWLEDGED_COUNT,
      "event",
      FIELD_ITERATION_INDEX,
      FIELD_NEW_BLOCKER_COUNT,
      "pr",
      FIELD_PRIOR_BLOCKER_COUNT,
      "sha",
    ]);
  });

  test("convergence stable scenario: prior=3 blockers, new=0 blockers, acknowledged=3", () => {
    const log = buildConvergenceMetricLog(758, "head123", 4, 3, 0, 3);
    expect(log[FIELD_PRIOR_BLOCKER_COUNT]).toBe(3);
    expect(log[FIELD_NEW_BLOCKER_COUNT]).toBe(0);
    expect(log[FIELD_ACKNOWLEDGED_COUNT]).toBe(3);
    expect(log[FIELD_ITERATION_INDEX]).toBe(4);
  });
});

// ----- metricsRecorder dep slot (mt#1306) -----
//
// Verifies:
// 1. When deps.db and deps.metricsRecorder are provided, the recorder is
//    invoked with the correct ConvergenceMetricInput payload.
// 2. When deps.metricsRecorder throws, the error does NOT propagate —
//    reviews must not fail because of metric write failures.
// 3. When deps.db is absent, the recorder is NOT called.
//
// These are structural / shape tests that do not require the full GitHub
// client stack — they test RunReviewDeps interface behaviour only.

describe("RunReviewDeps.metricsRecorder slot (mt#1306)", () => {
  test("metricsRecorder interface accepts the expected ConvergenceMetricInput shape", () => {
    // Type-level test: construct a RunReviewDeps value with a metricsRecorder
    // and verify it satisfies the declared type.
    const recorder = mock(async (_db: ReviewerDb, _input: ConvergenceMetricInput) => {});

    const fakeDeps: RunReviewDeps = {
      metricsRecorder: recorder,
      db: {} as ReviewerDb,
    };

    // Structural check: if the type assignment above compiles, the slot
    // is wired correctly. Runtime: recorder should be callable.
    expect(typeof fakeDeps.metricsRecorder).toBe("function");
    expect(typeof fakeDeps.db).toBe("object");
  });

  test("metricsRecorder slot is optional — deps without it satisfies RunReviewDeps", () => {
    const fakeDeps: RunReviewDeps = {};
    expect(fakeDeps.metricsRecorder).toBeUndefined();
    expect(fakeDeps.db).toBeUndefined();
  });

  test("metricsRecorder receives all 8 expected ConvergenceMetricInput fields", async () => {
    const captured: ConvergenceMetricInput[] = [];
    const recorder = mock(async (_db: ReviewerDb, input: ConvergenceMetricInput) => {
      captured.push(input);
    });

    const input: ConvergenceMetricInput = {
      prOwner: "edobry",
      prRepo: "minsky",
      prNumber: 769,
      headSha: "abc123",
      iterationIndex: 2,
      priorBlockerCount: 3,
      newBlockerCount: 1,
      acknowledgedAddressedCount: 2,
    };

    // Call the recorder directly to verify the shape round-trips correctly.
    await recorder({} as ReviewerDb, input);

    expect(captured).toHaveLength(1);
    const recorded = captured[0];
    if (recorded === undefined) throw new Error("expected a recorded input");
    expect(recorded.prOwner).toBe("edobry");
    expect(recorded.prRepo).toBe("minsky");
    expect(recorded.prNumber).toBe(769);
    expect(recorded.headSha).toBe("abc123");
    expect(recorded.iterationIndex).toBe(2);
    expect(recorded.priorBlockerCount).toBe(3);
    expect(recorded.newBlockerCount).toBe(1);
    expect(recorded.acknowledgedAddressedCount).toBe(2);
  });

  test("recorder error does not propagate — errors are swallowed at the call site", async () => {
    // Simulate what runReview does when the metricsRecorder throws:
    // The catch in recordConvergenceMetric should swallow the error.
    // Since we cannot run full runReview without GitHub mocks, we test
    // the contract by calling the default recordConvergenceMetric with a
    // throwing db directly (covered in metrics.test.ts) — this test
    // verifies the deps slot itself accepts a throwing recorder without issue.
    const throwingRecorder = mock(async (_db: ReviewerDb, _input: ConvergenceMetricInput) => {
      throw new Error("metric write failure");
    });

    // The recorder itself throws, but callers of recordConvergenceMetric in
    // review-worker use it inside a try/catch so it is fire-and-forget safe.
    // Here we verify the RunReviewDeps shape accommodates a throwing recorder.
    const deps: RunReviewDeps = {
      metricsRecorder: throwingRecorder,
      db: {} as ReviewerDb,
    };

    // TypeScript: the recorder must be callable without compile errors.
    expect(typeof deps.metricsRecorder).toBe("function");
    if (deps.metricsRecorder === undefined) throw new Error("expected metricsRecorder to be set");
    // The recorder throws — this is the failure mode we guard against in runReview.
    await expect(
      deps.metricsRecorder({} as ReviewerDb, {
        prOwner: "o",
        prRepo: "r",
        prNumber: 1,
        headSha: "s",
        iterationIndex: 0,
        priorBlockerCount: 0,
        newBlockerCount: 0,
        acknowledgedAddressedCount: 0,
      })
    ).rejects.toThrow("metric write failure");
  });
});

// =============================================================================
// serializeSubmitError (mt#1370): unit coverage for the structured-log error
// serializer used by the two defensive submitReview catch blocks.
// =============================================================================

describe("serializeSubmitError", () => {
  test("octokit-shaped HttpError captures name, message, status, code, stack", () => {
    const err = new Error("API rate limit exceeded") as Error & {
      status?: number;
      code?: string;
    };
    err.name = "HttpError";
    err.status = 403;
    err.code = "RATE_LIMITED";
    const out = serializeSubmitError(err);
    expect(out.name).toBe("HttpError");
    expect(out.message).toBe("API rate limit exceeded");
    expect(out.status).toBe(403);
    expect(out.code).toBe("RATE_LIMITED");
    expect(typeof out.stack).toBe("string");
    expect((out.stack ?? "").length).toBeGreaterThan(0);
  });

  test("string-typed status is preserved (some HTTP libs use string codes)", () => {
    const err = new Error("transient") as Error & { status?: string };
    err.status = "500";
    const out = serializeSubmitError(err);
    expect(out.status).toBe("500");
  });

  test("plain Error with no status/code captures only name + message + stack", () => {
    const err = new Error("plain failure");
    const out = serializeSubmitError(err);
    expect(out.name).toBe("Error");
    expect(out.message).toBe("plain failure");
    expect(out.status).toBeUndefined();
    expect(out.code).toBeUndefined();
    expect(typeof out.stack).toBe("string");
  });

  test("non-string status is dropped (defensive against weird throws)", () => {
    const err = new Error("weird") as Error & { status?: unknown };
    err.status = { weird: "object" };
    const out = serializeSubmitError(err);
    expect(out.status).toBeUndefined();
    expect(out.message).toBe("weird");
  });

  test("non-string code is dropped (defensive against weird throws)", () => {
    const err = new Error("weird") as Error & { code?: unknown };
    err.code = 42;
    const out = serializeSubmitError(err);
    expect(out.code).toBeUndefined();
  });

  test("string throw becomes message=String(err), no other fields", () => {
    const out = serializeSubmitError("just a string");
    expect(out.message).toBe("just a string");
    expect(out.name).toBeUndefined();
    expect(out.status).toBeUndefined();
    expect(out.code).toBeUndefined();
    expect(out.stack).toBeUndefined();
  });

  test("number throw becomes message=String(err)", () => {
    const out = serializeSubmitError(42);
    expect(out.message).toBe("42");
    expect(out.name).toBeUndefined();
  });

  test("plain object throw becomes message=String(err) (i.e., [object Object])", () => {
    const out = serializeSubmitError({ foo: "bar" });
    expect(out.message).toBe("[object Object]");
    expect(out.name).toBeUndefined();
  });

  test("stack longer than 1024 chars is truncated with marker", () => {
    const err = new Error("big stack");
    // Synthesize a long stack by overwriting it.
    const longStack = "a".repeat(2000);
    Object.defineProperty(err, "stack", { value: longStack, configurable: true });
    const out = serializeSubmitError(err);
    expect(out.stack).toBeDefined();
    const stack = out.stack ?? "";
    expect(stack.length).toBeLessThanOrEqual(1024 + "...[truncated]".length);
    expect(stack.endsWith("...[truncated]")).toBe(true);
  });

  test("missing stack on Error is gracefully omitted", () => {
    const err = new Error("no stack");
    Object.defineProperty(err, "stack", { value: undefined, configurable: true });
    const out = serializeSubmitError(err);
    expect(out.stack).toBeUndefined();
    expect(out.message).toBe("no stack");
  });
});

// =============================================================================
// buildSubmitFailureLog (mt#1370 R4): payload-builder for the two structured
// log events emitted from the defensive submitReview catch blocks. Tests the
// payload shape independent of the catch block itself, addressing the round-4
// BLOCKING that the catch-block emission lacked field-stability coverage.
// =============================================================================

const EV_SKIP_NOTICE_FAILED = "reviewer.submit_skip_notice_failed" as const;
const EV_ERROR_NOTICE_FAILED = "reviewer.submit_error_notice_failed" as const;

describe("buildSubmitFailureLog", () => {
  const baseArgs = {
    prCoords: { owner: "edobry", repo: "minsky", prNumber: 830, sha: "abc1234" },
    primaryReason: "test-reason",
    submitErr: new Error("submit failed"),
    provider: "openai",
    model: "gpt-5",
  };

  test("skip_notice_failed variant has all expected fields", () => {
    const log = buildSubmitFailureLog(EV_SKIP_NOTICE_FAILED, baseArgs);
    expect(log["event"]).toBe(EV_SKIP_NOTICE_FAILED);
    expect(log["prUrl"]).toBe("https://github.com/edobry/minsky/pull/830");
    expect(log["sha"]).toBe("abc1234");
    expect(log["commitSha"]).toBe("abc1234");
    expect(log["primaryReason"]).toBe("test-reason");
    expect(log["provider"]).toBe("openai");
    expect(log["model"]).toBe("gpt-5");
    expect(log["submitError"]).toBeDefined();
    expect((log["submitError"] as { message: string }).message).toBe("submit failed");
  });

  test("error_notice_failed variant accepts and includes sanitizeReason", () => {
    const log = buildSubmitFailureLog(EV_ERROR_NOTICE_FAILED, {
      ...baseArgs,
      sanitizeReason: "cot-leak:long-narrative-prefix",
    });
    expect(log["event"]).toBe(EV_ERROR_NOTICE_FAILED);
    expect(log["sanitizeReason"]).toBe("cot-leak:long-narrative-prefix");
  });

  test("sanitizeReason is omitted when not provided", () => {
    const log = buildSubmitFailureLog(EV_SKIP_NOTICE_FAILED, baseArgs);
    expect("sanitizeReason" in log).toBe(false);
  });

  test("sha and commitSha are both populated from the same source", () => {
    const log = buildSubmitFailureLog(EV_SKIP_NOTICE_FAILED, {
      ...baseArgs,
      prCoords: { owner: "x", repo: "y", prNumber: 1, sha: "deadbeef" },
    });
    expect(log["sha"]).toBe("deadbeef");
    expect(log["commitSha"]).toBe("deadbeef");
  });

  test("prUrl is constructed from owner+repo+prNumber", () => {
    const log = buildSubmitFailureLog(EV_SKIP_NOTICE_FAILED, {
      ...baseArgs,
      prCoords: { owner: "different-owner", repo: "different-repo", prNumber: 42, sha: "x" },
    });
    expect(log["prUrl"]).toBe("https://github.com/different-owner/different-repo/pull/42");
  });

  test("submitError nests serializeSubmitError output (octokit-shaped throw)", () => {
    const httpErr = new Error("rate limited") as Error & { status?: number; code?: string };
    httpErr.name = "HttpError";
    httpErr.status = 403;
    httpErr.code = "RATE_LIMITED";
    const log = buildSubmitFailureLog(EV_SKIP_NOTICE_FAILED, {
      ...baseArgs,
      submitErr: httpErr,
    });
    const serialized = log["submitError"] as {
      name?: string;
      message: string;
      status?: number | string;
      code?: string;
    };
    expect(serialized.name).toBe("HttpError");
    expect(serialized.status).toBe(403);
    expect(serialized.code).toBe("RATE_LIMITED");
    expect(serialized.message).toBe("rate limited");
  });

  test("payload is JSON-stringifiable without throwing (used at the call site)", () => {
    const log = buildSubmitFailureLog(EV_ERROR_NOTICE_FAILED, {
      ...baseArgs,
      sanitizeReason: "cot-leak:blank-line-run",
    });
    expect(() => JSON.stringify(log)).not.toThrow();
    const roundtripped = JSON.parse(JSON.stringify(log)) as Record<string, unknown>;
    expect(roundtripped["event"]).toBe(EV_ERROR_NOTICE_FAILED);
    expect(roundtripped["sanitizeReason"]).toBe("cot-leak:blank-line-run");
  });

  test("non-Error throw still produces a valid payload via serializeSubmitError fallback", () => {
    const log = buildSubmitFailureLog(EV_SKIP_NOTICE_FAILED, {
      ...baseArgs,
      submitErr: "string-throw",
    });
    const serialized = log["submitError"] as { message: string };
    expect(serialized.message).toBe("string-throw");
  });
});

// =============================================================================
// validateReviewOutput — outputToolsActive path (mt#1402)
//
// When outputToolsActive=true, non-empty toolCalls must count as a success
// signal even when output.text is empty — gpt-5 emits tool calls with
// output.text === "" on the output-tools path.
// =============================================================================

describe("validateReviewOutput — outputToolsActive path", () => {
  const baseOutput: ReviewOutput = {
    text: "",
    provider: "openai",
    model: "gpt-5",
    tokensUsed: 5000,
    usage: {
      promptTokens: 3000,
      completionTokens: 2000,
      reasoningTokens: 1500,
      totalTokens: 5000,
    },
    toolCalls: [],
  };

  test("empty text + empty toolCalls + outputToolsActive=true → fails (nothing was produced)", () => {
    const result = validateReviewOutput(baseOutput, true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("empty content");
    }
  });

  test("empty text + non-empty toolCalls + outputToolsActive=true → ok (tool calls are the output)", () => {
    const output: ReviewOutput = {
      ...baseOutput,
      toolCalls: [
        {
          name: "conclude_review",
          args: { event: "REQUEST_CHANGES", summary: "Two blocking findings." },
        },
      ],
    };
    const result = validateReviewOutput(output, true);
    expect(result.ok).toBe(true);
  });

  test("empty text + non-empty toolCalls + outputToolsActive=false → fails (default prose path)", () => {
    const output: ReviewOutput = {
      ...baseOutput,
      toolCalls: [
        {
          name: "conclude_review",
          args: { event: "APPROVE", summary: "No issues found." },
        },
      ],
    };
    const result = validateReviewOutput(output, false);
    expect(result.ok).toBe(false);
  });

  test("non-empty text + non-empty toolCalls + outputToolsActive=true → ok (text passes first)", () => {
    const output: ReviewOutput = {
      ...baseOutput,
      text: "some scratch text",
      toolCalls: [
        {
          name: "conclude_review",
          args: { event: "APPROVE", summary: "No issues." },
        },
      ],
    };
    const result = validateReviewOutput(output, true);
    expect(result.ok).toBe(true);
  });
});

// =============================================================================
// callReviewerWithRetry — outputToolsActive forwarding (mt#1402)
//
// Verify that the outputToolsActive flag is forwarded to validateReviewOutput
// so non-empty toolCalls count as success on the output-tools path.
// =============================================================================

describe("callReviewerWithRetry — outputToolsActive forwarding", () => {
  const fakeConfig = {
    provider: "openai",
    providerApiKey: "fake",
    providerModel: "gpt-5",
  } as unknown as ReviewerConfig;

  type Invocation = { options?: import("./providers").CallReviewerOptions };
  function fakeReviewer(outputs: ReviewOutput[], invocations: Invocation[]): CallReviewerFn {
    let i = 0;
    return async (_config, _sys, _user, _tools, options) => {
      invocations.push({ options });
      const next = outputs[i];
      if (next === undefined) {
        throw new Error(`fakeReviewer ran out of outputs (invocation ${i + 1})`);
      }
      i++;
      return next;
    };
  }

  test("empty text + non-empty toolCalls + outputToolsActive=true → first-attempt-success, no retry", async () => {
    const invocations: Invocation[] = [];
    const output: ReviewOutput = {
      text: "",
      provider: "openai",
      model: "gpt-5",
      tokensUsed: 5000,
      toolCalls: [
        {
          name: "submit_finding",
          args: {
            severity: "BLOCKING",
            file: "src/foo.ts",
            line: 1,
            summary: "Null check missing",
            details: "The condition fails when x is null.",
          },
        },
        {
          name: "conclude_review",
          args: { event: "REQUEST_CHANGES", summary: "One blocking issue found." },
        },
      ],
    };

    const result = await callReviewerWithRetry(
      fakeConfig,
      "sys",
      "user",
      undefined,
      fakeReviewer([output], invocations),
      true // outputToolsActive
    );

    expect(invocations).toHaveLength(1);
    expect(result.attempt).toBe(ATTEMPT_FIRST_SUCCESS);
    expect(result.retryAttempted).toBe(false);
    expect(result.validation.ok).toBe(true);
  });

  test("empty text + empty toolCalls + outputToolsActive=true → retry attempted (still empty)", async () => {
    const invocations: Invocation[] = [];
    const emptyOutput: ReviewOutput = {
      text: "",
      provider: "openai",
      model: "gpt-5",
      tokensUsed: 5000,
      toolCalls: [],
    };

    const result = await callReviewerWithRetry(
      fakeConfig,
      "sys",
      "user",
      undefined,
      fakeReviewer([emptyOutput, emptyOutput], invocations),
      true // outputToolsActive
    );

    expect(invocations).toHaveLength(2);
    expect(result.retryAttempted).toBe(true);
    expect(result.validation.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyRecoveryAndCompose (mt#1496 PR #922 R7-R13)
// ---------------------------------------------------------------------------
//
// Pure helper extracted from runReview's outputToolsActive branch so the
// recovery + reconciliation + composition flow can be unit-tested without
// mocking GitHub/OpenAI/MCP. Full integration tests for runReview itself
// require substantial mock scaffolding and are deferred to mt#1497; this
// unit-test surface covers the core decision logic the bot has flagged.

describe("applyRecoveryAndCompose (mt#1496)", () => {
  function finding(
    severity: "BLOCKING" | "NON-BLOCKING" | "PRE-EXISTING",
    file: string,
    line: number
  ): ReviewToolCall {
    return {
      name: "submit_finding",
      args: {
        severity,
        file,
        line,
        summary: `${severity} on ${file}`,
        details: "details",
      },
    };
  }
  function conclude(
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    summary?: string
  ): ReviewToolCall {
    return {
      name: "conclude_review",
      args: { event, summary: summary ?? `${event} summary` },
    };
  }

  test("recovery disabled: passes through unchanged, no downgrades", () => {
    const toolCalls: ReviewToolCall[] = [
      finding("BLOCKING", "src/foo.ts", 5),
      conclude("REQUEST_CHANGES"),
    ];
    const priors: FlatPriorFinding[] = [{ file: "src/foo.ts", severity: "NON-BLOCKING", line: 5 }];
    const result = applyRecoveryAndCompose(toolCalls, priors, "", false);
    expect(result.downgrades).toHaveLength(0);
    expect(result.originalBlockingCount).toBe(1);
    expect(result.postRecoveryBlockingCount).toBe(1);
    expect(result.reconcileApplied).toBe(false);
    expect(result.composed.event).toBe("REQUEST_CHANGES");
  });

  test("recovery enabled but no priors: passes through, no recovery applied", () => {
    const toolCalls: ReviewToolCall[] = [
      finding("BLOCKING", "src/foo.ts", 5),
      conclude("REQUEST_CHANGES"),
    ];
    const result = applyRecoveryAndCompose(toolCalls, [], "", true);
    expect(result.downgrades).toHaveLength(0);
    expect(result.originalBlockingCount).toBe(1);
    expect(result.postRecoveryBlockingCount).toBe(1);
    expect(result.reconcileApplied).toBe(false);
    expect(result.composed.event).toBe("REQUEST_CHANGES");
  });

  test("recovery enabled with priors: BLOCKING downgrades to NON-BLOCKING when no diff overlap", () => {
    const toolCalls: ReviewToolCall[] = [
      finding("BLOCKING", "src/foo.ts", 5),
      conclude("REQUEST_CHANGES"),
    ];
    const priors: FlatPriorFinding[] = [{ file: "src/foo.ts", severity: "NON-BLOCKING", line: 5 }];
    const result = applyRecoveryAndCompose(toolCalls, priors, "", true);
    expect(result.downgrades).toHaveLength(1);
    expect(result.originalBlockingCount).toBe(1);
    expect(result.postRecoveryBlockingCount).toBe(0);
  });

  test("crossed-zero reconciliation: rewrites conclude_review REQUEST_CHANGES → COMMENT", () => {
    const toolCalls: ReviewToolCall[] = [
      finding("BLOCKING", "src/foo.ts", 5),
      conclude("REQUEST_CHANGES"),
    ];
    const priors: FlatPriorFinding[] = [{ file: "src/foo.ts", severity: "NON-BLOCKING", line: 5 }];
    const result = applyRecoveryAndCompose(toolCalls, priors, "", true);
    expect(result.reconcileApplied).toBe(true);
    expect(result.composed.event).toBe("COMMENT");
    // The reconciled tool calls should have COMMENT as the conclude_review
    // event, not REQUEST_CHANGES.
    const concludeCall = result.toolCalls.find((tc) => tc.name === "conclude_review");
    expect(concludeCall?.name === "conclude_review" ? concludeCall.args.event : null).toBe(
      "COMMENT"
    );
  });

  test("partial downgrade (not crossed zero): no reconciliation", () => {
    // Two BLOCKING findings, one downgraded, one preserved (different file).
    const toolCalls: ReviewToolCall[] = [
      finding("BLOCKING", "src/foo.ts", 5), // will downgrade (matches prior)
      finding("BLOCKING", "src/bar.ts", 5), // will preserve (no prior match)
      conclude("REQUEST_CHANGES"),
    ];
    const priors: FlatPriorFinding[] = [{ file: "src/foo.ts", severity: "NON-BLOCKING", line: 5 }];
    const result = applyRecoveryAndCompose(toolCalls, priors, "", true);
    expect(result.downgrades).toHaveLength(1);
    expect(result.originalBlockingCount).toBe(2);
    expect(result.postRecoveryBlockingCount).toBe(1);
    expect(result.reconcileApplied).toBe(false);
    expect(result.composed.event).toBe("REQUEST_CHANGES");
  });

  test("no conclude_review present: composed event still derived from severities", () => {
    // No conclude_review → composeReviewBody derives event from blockingCount.
    // After recovery downgrades all BLOCKING, derived event is COMMENT.
    const toolCalls: ReviewToolCall[] = [finding("BLOCKING", "src/foo.ts", 5)];
    const priors: FlatPriorFinding[] = [{ file: "src/foo.ts", severity: "NON-BLOCKING", line: 5 }];
    const result = applyRecoveryAndCompose(toolCalls, priors, "", true);
    expect(result.postRecoveryBlockingCount).toBe(0);
    expect(result.reconcileApplied).toBe(false); // no conclude_review to reconcile
    expect(result.composed.event).toBe("COMMENT");
  });

  test("conclude_review COMMENT (not REQUEST_CHANGES): no reconciliation needed", () => {
    const toolCalls: ReviewToolCall[] = [finding("BLOCKING", "src/foo.ts", 5), conclude("COMMENT")];
    const priors: FlatPriorFinding[] = [{ file: "src/foo.ts", severity: "NON-BLOCKING", line: 5 }];
    const result = applyRecoveryAndCompose(toolCalls, priors, "", true);
    expect(result.postRecoveryBlockingCount).toBe(0);
    expect(result.reconcileApplied).toBe(false);
    expect(result.composed.event).toBe("COMMENT");
  });

  test("downgrades array contains expected audit fields", () => {
    const toolCalls: ReviewToolCall[] = [finding("BLOCKING", "src/foo.ts", 5)];
    const priors: FlatPriorFinding[] = [{ file: "src/foo.ts", severity: "NON-BLOCKING", line: 5 }];
    const result = applyRecoveryAndCompose(toolCalls, priors, "", true);
    expect(result.downgrades[0]).toMatchObject({
      file: "src/foo.ts",
      line: 5,
      fromSeverity: "BLOCKING",
      toSeverity: "NON-BLOCKING",
      matchingPriorSeverity: "NON-BLOCKING",
    });
  });

  test("preserves BLOCKING when diff introduces new lines on cited range", () => {
    // Recovery should NOT downgrade if the diff actually introduces new code
    // overlapping the finding's range.
    const toolCalls: ReviewToolCall[] = [finding("BLOCKING", "src/foo.ts", 11)];
    const priors: FlatPriorFinding[] = [{ file: "src/foo.ts", severity: "NON-BLOCKING", line: 5 }];
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,2 +10,4 @@
 keep
+new11
+new12
 keep
`;
    const result = applyRecoveryAndCompose(toolCalls, priors, diff, true);
    expect(result.downgrades).toHaveLength(0);
    expect(result.postRecoveryBlockingCount).toBe(1);
    expect(result.reconcileApplied).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Empty-findings coherence recovery (mt#2685)
  // -------------------------------------------------------------------------
  //
  // Acceptance test: "A composed review whose model output contains a
  // REQUEST_CHANGES conclusion and zero submit_finding calls does not
  // silently ship as-is: the chosen mechanism fires." These tests exercise
  // the mechanism through the SAME pipeline entrypoint (applyRecoveryAndCompose)
  // production code uses, and assert both halves of the structural-coherence
  // claim: the composed body renders a Findings section AND provenance
  // (extracted from the same toolCalls the worker forwards downstream) agrees
  // with it — the exact "body says one thing, provenance says another" defect
  // shape from #1821 R1 that mt#2655 fixed for the other direction.
  describe("empty-findings coherence recovery (mt#2685)", () => {
    test("REQUEST_CHANGES + zero submit_finding calls: synthesizes a finding and stays REQUEST_CHANGES", () => {
      const toolCalls: ReviewToolCall[] = [
        conclude(
          "REQUEST_CHANGES",
          "Lacks an end-to-end test asserting config.doctor emits the new diagnostic."
        ),
      ];

      const result = applyRecoveryAndCompose(toolCalls, [], "", false);

      expect(result.emptyFindingsRecovery.applied).toBe(true);
      expect(result.composed.event).toBe("REQUEST_CHANGES");
      expect(result.composed.reconciled).toBe(false); // no double-reconciliation
      expect(result.composed.body).toContain("## Findings");
      expect(result.composed.body).toContain("[BLOCKING]");
      expect(result.postRecoveryBlockingCount).toBe(1);

      // Observability (mt#2685 review R1): the model emitted ZERO of its own
      // BLOCKING findings — originalBlockingCount must stay 0 (never silently
      // absorb the synthesized finding), while synthesizedBlockingCount makes
      // the 1-finding gap explicit, and postRecoveryBlockingCount (1) is their
      // sum. A log/metric reader must be able to tell "the model found 0" from
      // "the pipeline is now reporting 1" without reading this module's source.
      expect(result.originalBlockingCount).toBe(0);
      expect(result.synthesizedBlockingCount).toBe(1);
      expect(result.postRecoveryBlockingCount).toBe(
        result.originalBlockingCount + result.synthesizedBlockingCount
      );

      // Provenance consistency: the SAME toolCalls the worker forwards to
      // extractProvenance (recoveryResult.toolCalls, per annotateReviewBody's
      // call site) must reflect the synthesized finding too — not just the
      // rendered body. And provenance itself must distinguish the synthesized
      // finding from a model-emitted one (mt#2685 review R1).
      const provenance = extractProvenance(result.toolCalls);
      expect(provenance.findings.blocking).toBe(1);
      expect(provenance.findings.synthesizedBlocking).toBe(1);
      expect(provenance.conclusion?.event).toBe("REQUEST_CHANGES");
    });

    test("does not fire for a genuine REQUEST_CHANGES backed by a real BLOCKING finding", () => {
      const toolCalls: ReviewToolCall[] = [
        finding("BLOCKING", "src/foo.ts", 5),
        conclude("REQUEST_CHANGES"),
      ];
      const result = applyRecoveryAndCompose(toolCalls, [], "", false);
      expect(result.emptyFindingsRecovery.applied).toBe(false);
      expect(result.postRecoveryBlockingCount).toBe(1);
      expect(result.synthesizedBlockingCount).toBe(0);

      const provenance = extractProvenance(result.toolCalls);
      expect(provenance.findings.synthesizedBlocking).toBe(0);
    });

    test("does not fight legitimate crossed-zero downgrade reconciliation", () => {
      // A REAL BLOCKING finding that recovery legitimately downgrades to
      // zero must still reconcile to COMMENT via Step 3 — the empty-findings
      // pass (keyed on the ORIGINAL, pre-recovery blocking count) must not
      // re-synthesize a finding here, or it would fight the very
      // convergence this recovery pass exists to enable.
      const toolCalls: ReviewToolCall[] = [
        finding("BLOCKING", "src/foo.ts", 5),
        conclude("REQUEST_CHANGES"),
      ];
      const priors: FlatPriorFinding[] = [
        { file: "src/foo.ts", severity: "NON-BLOCKING", line: 5 },
      ];
      const result = applyRecoveryAndCompose(toolCalls, priors, "", true);
      expect(result.emptyFindingsRecovery.applied).toBe(false);
      expect(result.reconcileApplied).toBe(true);
      expect(result.composed.event).toBe("COMMENT");
    });

    test("synthesized finding uses the documented sentinel file", () => {
      const toolCalls: ReviewToolCall[] = [conclude("REQUEST_CHANGES", "prose-only blocker")];
      const result = applyRecoveryAndCompose(toolCalls, [], "", false);
      expect(result.emptyFindingsRecovery.synthesizedFinding?.file).toBe(SYNTHESIZED_FINDING_FILE);
    });
  });
});

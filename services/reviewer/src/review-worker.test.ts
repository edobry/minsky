import { beforeEach, describe, expect, test, mock } from "bun:test";
import {
  parseReviewEvent,
  validateReviewOutput,
  buildEmptyOutputSkipNotice,
  decidePostSanitizeOutcome,
  callReviewerWithRetry,
  decideToolsActive,
  defaultForkAccessProbe,
  type CallReviewerFn,
} from "./review-worker";
import type { CallReviewerOptions, ReviewOutput } from "./providers";
import type { ReviewerConfig } from "./config";
import type { ReviewerToolContext, ReadFileResult } from "./tools";
import type { SanitizeResult } from "./sanitize";

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
      undefined,
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
    attempt: "first-attempt-success" as const,
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

import { beforeEach, describe, expect, test, mock } from "bun:test";
import {
  parseReviewEvent,
  validateReviewOutput,
  buildEmptyOutputSkipNotice,
  decidePostSanitizeOutcome,
  callReviewerWithRetry,
  decideToolsActive,
  defaultForkAccessProbe,
  runReview,
  type CallReviewerFn,
} from "./review-worker";
import type { CallReviewerOptions, ReviewOutput } from "./providers";
import type { ReviewerConfig } from "./config";
import type { ReviewerToolContext, ReadFileResult } from "./tools";
import type { SanitizeResult } from "./sanitize";

// ---------------------------------------------------------------------------
// Module-level mocks for runReview end-to-end tests (mt#1263).
//
// mock.module() captures references at call time. To allow per-test control,
// we use an indirection container: the module factory exposes a wrapper that
// delegates to `stubs.<key>`, and tests reassign `stubs.<key> = mock(newImpl)`.
// Property reassignment on a const object is valid — no const-assign lint
// violation, no .mockImplementation() needed (no-jest-patterns compliance).
//
// mock.module() is permitted in this file via eslint.config.js allowInFiles
// because the reviewer service has no DI infrastructure; this is the only
// available seam for testing runReview end-to-end.
// ---------------------------------------------------------------------------

// Stub container — properties are reassigned per test inside beforeEach / test.
const stubs = {
  submitReview: mock(
    (
      _octokit: unknown,
      _owner: string,
      _repo: string,
      _prNumber: number,
      _event: string,
      _body: string
    ) =>
      Promise.resolve({
        id: 1,
        htmlUrl: "https://github.com/owner/repo/pull/1#pullrequestreview-1",
      })
  ),
  callReviewer: mock(
    async (): Promise<ReviewOutput> => ({
      text: "## Findings\n\n- [NON-BLOCKING] Minor nit.\n\nEvent: APPROVE",
      provider: "openai",
      model: "gpt-5",
      tokensUsed: 500,
      usage: { promptTokens: 300, completionTokens: 200, totalTokens: 500 },
    })
  ),
  sanitizeReviewBody: mock(
    (raw: string): SanitizeResult => ({
      action: "passthrough",
      body: raw,
      meta: { originalLength: raw.length, cleanedLength: raw.length },
    })
  ),
};

mock.module("./github-client", () => ({
  createOctokit: mock(() => Promise.resolve({})),
  fetchPullRequestContext: mock(() =>
    Promise.resolve({
      number: 42,
      title: "Test PR",
      body: "<!-- minsky:tier=3 -->",
      owner: "owner",
      repo: "repo",
      headOwner: "owner",
      headRepo: "repo",
      isForkedPR: false,
      branchName: "task/mt-1263",
      baseBranch: "main",
      diff: "diff --git a/foo.ts b/foo.ts\n+added line",
      headSha: "abc123",
    })
  ),
  getAppIdentity: mock(() => Promise.resolve({ login: "minsky-reviewer[bot]" })),
  // Wrapper delegates to stubs.submitReview so per-test reassignment is visible.
  submitReview: (...args: Parameters<typeof stubs.submitReview>) => stubs.submitReview(...args),
  // readFileAtRef and listDirectoryAtRef are NOT mocked here so the
  // defaultForkAccessProbe tests (which construct their own octokit stubs)
  // continue to call the real readFileAtRef implementation. The runReview
  // tests use isForkedPR=false so the probe is never invoked.
}));

mock.module("./providers", () => ({
  // Wrapper delegates to stubs.callReviewer so per-test reassignment is visible.
  callReviewer: (...args: Parameters<typeof stubs.callReviewer>) => stubs.callReviewer(...args),
}));

mock.module("./sanitize", () => ({
  // Wrapper delegates to stubs.sanitizeReviewBody so per-test reassignment is visible.
  sanitizeReviewBody: (...args: Parameters<typeof stubs.sanitizeReviewBody>) =>
    stubs.sanitizeReviewBody(...args),
}));

mock.module("./tier-routing", () => ({
  resolveTier: mock(() => Promise.resolve(3)),
  decideRouting: mock(() => ({ shouldReview: true, reason: "tier 3 enabled" })),
  extractTierFromPRBody: mock(() => 3),
}));

mock.module("./task-spec-fetch", () => ({
  resolveTaskSpec: mock(() =>
    Promise.resolve({ taskSpec: null, fetchResult: { status: "no-task-id" } })
  ),
  extractTaskId: mock(() => null),
}));

mock.module("./prompt", () => ({
  buildReviewPrompt: mock(() => "user prompt text"),
  buildCriticConstitution: mock(() => "system prompt text"),
}));

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

// ----- runReview sanitize wiring (mt#1263) -----
//
// End-to-end coverage for the CoT-leakage guard wired into runReview by
// mt#1212. Three cases correspond to the three SanitizeResult.action values.
// All external I/O is stubbed via mock.module() at the top of this file.
//
// Mutation-test protocol (described in PR body):
//   Temporarily break wiring by passing `output.text` instead of
//   `sanitized.body` to submitReview in review-worker.ts, then confirm
//   cases 1 and 2 fail. Revert before committing.

describe("runReview sanitize wiring (mt#1263)", () => {
  const fakeConfig: ReviewerConfig = {
    appId: 1,
    privateKey: "fake-key",
    installationId: 1,
    webhookSecret: "fake-secret",
    provider: "openai",
    providerApiKey: "sk-fake",
    providerModel: "gpt-5",
    tier2Enabled: false,
    mcpUrl: undefined,
    mcpToken: undefined,
    port: 3000,
    logLevel: "info",
  };

  const RAW_OUTPUT_TEXT =
    "## Findings\n\n- [BLOCKING] src/foo.ts:1 — bad.\n\nEvent: REQUEST_CHANGES";

  beforeEach(() => {
    // Reset call history before each test.
    stubs.submitReview.mockReset();
    stubs.callReviewer.mockReset();
    stubs.sanitizeReviewBody.mockReset();

    // Default reviewer output — substantive, non-empty.
    // Property reassignment on the const `stubs` object is lint-safe (not const-assign).
    stubs.callReviewer = mock(
      async (): Promise<ReviewOutput> => ({
        text: RAW_OUTPUT_TEXT,
        provider: "openai",
        model: "gpt-5",
        tokensUsed: 500,
        usage: { promptTokens: 300, completionTokens: 200, totalTokens: 500 },
      })
    );

    // Default submitReview — succeeds with a stub review.
    stubs.submitReview = mock(() =>
      Promise.resolve({
        id: 99,
        htmlUrl: "https://github.com/owner/repo/pull/42#pullrequestreview-99",
      })
    );

    // Default sanitize — passthrough (no stripping).
    stubs.sanitizeReviewBody = mock(
      (raw: string): SanitizeResult => ({
        action: "passthrough",
        body: raw,
        meta: { originalLength: raw.length, cleanedLength: raw.length },
      })
    );
  });

  // ── Case 1: sanitize returns "stripped" ─────────────────────────────────
  //
  // submitReview receives sanitized.body (NOT raw output.text).
  // The stripped body is intentionally DIFFERENT from the raw output so the
  // mutation test (passing output.text instead of sanitized.body) fails.
  // parseReviewEvent is called on the stripped body, so the event is derived
  // from it. Return value: status="reviewed", reason contains "[cot-leakage: stripped]".

  test("stripped: submitReview receives sanitized.body; reason contains leak marker", async () => {
    // strippedBody is intentionally distinct from RAW_OUTPUT_TEXT so that
    // passing output.text instead of sanitized.body causes this test to fail.
    const strippedBody =
      "## Findings\n\n- [BLOCKING] src/bar.ts:10 — STRIPPED ONLY CONTENT.\n\nEvent: REQUEST_CHANGES";

    stubs.sanitizeReviewBody = mock(
      (_raw: string): SanitizeResult => ({
        action: "stripped",
        body: strippedBody,
        meta: {
          originalLength: 5000,
          cleanedLength: strippedBody.length,
          reason: "cot-leak:blank-line-run,scratch:this-time-for-sure",
        },
      })
    );

    const result = await runReview(fakeConfig, "owner", "repo", 42, "pr-author");

    // submitReview must receive the STRIPPED body (annotated), NOT raw output.text.
    expect(stubs.submitReview).toHaveBeenCalledTimes(1);
    const [, , , , event, body] = stubs.submitReview.mock.calls[0] as [
      unknown,
      string,
      string,
      number,
      string,
      string,
    ];
    // The body passed to submitReview is annotateReviewBody(sanitized.body, ...),
    // which prepends a header. Confirm the STRIPPED body text is present.
    expect(body).toContain(strippedBody);
    // The raw output text must NOT appear verbatim in the body (mutation-test sentinel).
    expect(body).not.toContain(RAW_OUTPUT_TEXT);

    // parseReviewEvent operates on the stripped body → REQUEST_CHANGES keyword present.
    expect(event).toBe("REQUEST_CHANGES");

    // Return value shape.
    expect(result.status).toBe("reviewed");
    expect(result.reason).toContain("[cot-leakage: stripped]");
    expect(result.review).toBeDefined();
  });

  // ── Case 2: sanitize returns "errored" ──────────────────────────────────
  //
  // submitReview receives the error-notice body (sanitized.body).
  // event is forced to "COMMENT" regardless of what parseReviewEvent would return.
  // Return value: status="error", NO review field populated.
  // A submitReview failure on this path does NOT propagate (try/catch).

  test("errored: submitReview receives error-notice body; status=error; review field absent", async () => {
    const errorNoticeBody =
      "**reviewer-service error: chain-of-thought leakage detected**\n\n" +
      "The upstream model emitted raw internal reasoning into the review body.";

    stubs.sanitizeReviewBody = mock(
      (_raw: string): SanitizeResult => ({
        action: "errored",
        body: errorNoticeBody,
        meta: {
          originalLength: 1200,
          cleanedLength: errorNoticeBody.length,
          reason: "cot-leak:scratch:openai-tool-routing,long-narrative-prefix",
        },
      })
    );

    const result = await runReview(fakeConfig, "owner", "repo", 42, "pr-author");

    expect(stubs.submitReview).toHaveBeenCalledTimes(1);
    const [, , , , event, body] = stubs.submitReview.mock.calls[0] as [
      unknown,
      string,
      string,
      number,
      string,
      string,
    ];
    // Event must be COMMENT regardless of what parseReviewEvent would produce.
    expect(event).toBe("COMMENT");
    // Body contains the error notice text.
    expect(body).toContain(errorNoticeBody);

    // Status is error, review field is NOT populated.
    expect(result.status).toBe("error");
    expect(result.review).toBeUndefined();
  });

  test("errored: submitReview failure does not propagate (try/catch mirrors mt#1125 pattern)", async () => {
    const errorNoticeBody = "**reviewer-service error: chain-of-thought leakage detected**";

    stubs.sanitizeReviewBody = mock(
      (_raw: string): SanitizeResult => ({
        action: "errored",
        body: errorNoticeBody,
        meta: {
          originalLength: 800,
          cleanedLength: errorNoticeBody.length,
          reason: "cot-leak:blank-line-run",
        },
      })
    );

    // Make submitReview throw on the error path.
    stubs.submitReview = mock(() => {
      throw new Error("GitHub API unavailable");
    });

    // runReview must not re-throw the submitReview error.
    const result = await runReview(fakeConfig, "owner", "repo", 42, "pr-author");
    expect(result.status).toBe("error");
    expect(result.review).toBeUndefined();
  });

  // ── Case 3: sanitize returns "passthrough" ──────────────────────────────
  //
  // submitReview receives the raw output.text (via annotateReviewBody).
  // No reviewer.cot_leak_detected log is emitted — console.log is mocked
  // globally via tests/setup.ts; the setup mock counts calls.

  test("passthrough: submitReview receives raw output.text; no cot_leak log emitted", async () => {
    // stubs.sanitizeReviewBody is already set to passthrough in beforeEach.

    // Spy on console.log to verify reviewer.cot_leak_detected is NOT emitted.
    // (tests/setup.ts already replaces console.log with a mock() globally;
    // capture its state before and confirm cot_leak_detected key is absent.)
    const consoleLogCalls: unknown[][] = [];
    const originalConsoleLog = console.log;
    console.log = mock((...args: unknown[]) => {
      consoleLogCalls.push(args);
    }) as typeof console.log;

    try {
      const result = await runReview(fakeConfig, "owner", "repo", 42, "pr-author");

      expect(stubs.submitReview).toHaveBeenCalledTimes(1);
      const [, , , , , body] = stubs.submitReview.mock.calls[0] as [
        unknown,
        string,
        string,
        number,
        string,
        string,
      ];
      // Body must contain the raw output text (no stripped prefix replacement).
      expect(body).toContain(RAW_OUTPUT_TEXT);

      // No reviewer.cot_leak_detected log must have been emitted.
      const leakLogs = consoleLogCalls.filter((args) => {
        const first = args[0];
        if (typeof first !== "string") return false;
        try {
          const parsed = JSON.parse(first) as Record<string, unknown>;
          return parsed.event === "reviewer.cot_leak_detected";
        } catch {
          return false;
        }
      });
      expect(leakLogs).toHaveLength(0);

      expect(result.status).toBe("reviewed");
      expect(result.review).toBeDefined();
    } finally {
      console.log = originalConsoleLog;
    }
  });
});

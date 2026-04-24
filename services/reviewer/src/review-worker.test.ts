import { describe, expect, test, mock } from "bun:test";
import {
  parseReviewEvent,
  validateReviewOutput,
  buildEmptyOutputSkipNotice,
  decidePostSanitizeOutcome,
} from "./review-worker";
import type { ReviewOutput } from "./providers";
import type { ReviewerToolContext } from "./tools";
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
    // parseReviewEvent looks at the LAST 400 chars for APPROVE / REQUEST_CHANGES.
    // The skip notice must not accidentally signal either — it's a neutral comment.
    const notice = buildEmptyOutputSkipNotice(emptyOutput);
    const tail = notice.slice(-400).toUpperCase();
    expect(tail).not.toMatch(/\bREQUEST_CHANGES\b/);
    expect(tail).not.toMatch(/\bAPPROVE\b/);
  });
});

// ----- ReviewerToolContext integration -----
//
// Verify that a ReviewerToolContext with the correct shape can be constructed
// and that the readFile / listDirectory callbacks close over the right data.
// (The actual wiring into callReviewer is covered in providers.test.ts.)

describe("ReviewerToolContext shape", () => {
  test("readFile callback returns string or null", async () => {
    const readFile = mock(async (path: string): Promise<string | null> => {
      if (path === "src/exists.ts") return "file content";
      return null;
    });

    const tools: ReviewerToolContext = {
      readFile,
      listDirectory: mock(async () => null),
    };

    expect(await tools.readFile("src/exists.ts")).toBe("file content");
    expect(await tools.readFile("src/missing.ts")).toBeNull();
  });

  test("listDirectory callback returns entries or null", async () => {
    const entries = [
      { name: "index.ts", type: "file" as const },
      { name: "lib", type: "dir" as const },
    ];
    const listDirectory = mock(
      async (path: string): Promise<Array<{ name: string; type: "file" | "dir" }> | null> => {
        if (path === "src") return entries;
        return null;
      }
    );

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
});

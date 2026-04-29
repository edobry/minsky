import { describe, expect, it } from "bun:test";
import { evaluateCheckRunsPresence, parseCheckRunsResponse } from "./require-review-before-merge";

describe("parseCheckRunsResponse (mt#1309)", () => {
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });

  it("returns count from total_count when present", () => {
    const result = parseCheckRunsResponse(ok('{"total_count":2,"check_runs":[]}'));
    expect(result).toEqual({ ok: true, count: 2 });
  });

  it("falls back to check_runs.length when total_count is missing", () => {
    const result = parseCheckRunsResponse(ok('{"check_runs":[{"id":1},{"id":2},{"id":3}]}'));
    expect(result).toEqual({ ok: true, count: 3 });
  });

  it("returns count=0 when total_count is 0 (the webhook-miss case)", () => {
    const result = parseCheckRunsResponse(ok('{"total_count":0,"check_runs":[]}'));
    expect(result).toEqual({ ok: true, count: 0 });
  });

  it("returns failure when gh api exits non-zero", () => {
    const result = parseCheckRunsResponse({
      exitCode: 1,
      stdout: "",
      stderr: "rate limit exceeded",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("exited 1");
      expect(result.error).toContain("rate limit");
    }
  });

  it("returns failure with placeholder stderr when stderr is empty", () => {
    const result = parseCheckRunsResponse({ exitCode: 1, stdout: "", stderr: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("(no stderr)");
    }
  });

  it("returns failure when stdout is empty (zero exit)", () => {
    const result = parseCheckRunsResponse(ok(""));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("empty response");
    }
  });

  it("returns failure when stdout is not valid JSON", () => {
    const result = parseCheckRunsResponse(ok("not-json{{"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("failed to parse");
    }
  });

  it("returns failure when JSON is not an object (array)", () => {
    const result = parseCheckRunsResponse(ok("[1,2,3]"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // arrays still hit the "missing total_count and check_runs[]" path
      expect(result.error).toBeDefined();
    }
  });

  it("returns failure when JSON is null", () => {
    const result = parseCheckRunsResponse(ok("null"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not an object");
    }
  });

  it("returns failure when neither total_count nor check_runs is present", () => {
    const result = parseCheckRunsResponse(ok('{"message":"Not Found"}'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("missing total_count");
    }
  });
});

describe("evaluateCheckRunsPresence (mt#1309)", () => {
  const pr = "855";
  const headSha = "3f1b048c486e1f49f26db71836b86b3ee4eb026d";
  const okWith = (count: number) => ({ ok: true as const, count });
  const failWith = (error: string) => ({ ok: false as const, error });

  it("allows merge when at least one check_run fired", () => {
    const result = evaluateCheckRunsPresence(okWith(2), pr, headSha);
    expect(result.deny).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("allows merge with a single check_run", () => {
    expect(evaluateCheckRunsPresence(okWith(1), pr, headSha).deny).toBe(false);
  });

  it("denies merge when zero check_runs fired (the webhook-miss class)", () => {
    const result = evaluateCheckRunsPresence(okWith(0), pr, headSha);
    expect(result.deny).toBe(true);
    expect(result.reason).toBeDefined();
  });

  it("webhook-miss denial reason names mt#1309 and PR #763 lineage", () => {
    const result = evaluateCheckRunsPresence(okWith(0), pr, headSha);
    expect(result.reason).toContain("mt#1309");
    expect(result.reason).toContain("PR #763");
  });

  it("webhook-miss denial reason points at the empty-commit recovery path", () => {
    const result = evaluateCheckRunsPresence(okWith(0), pr, headSha);
    expect(result.reason).toContain("empty commit");
    expect(result.reason).toContain("noFiles");
    expect(result.reason).toContain("noStage");
  });

  it("webhook-miss denial reason references /review-pr step 7a as the bypass-merge fallback", () => {
    const result = evaluateCheckRunsPresence(okWith(0), pr, headSha);
    expect(result.reason).toContain("/review-pr step 7a");
  });

  it("webhook-miss denial reason includes the short HEAD sha for triage", () => {
    const result = evaluateCheckRunsPresence(okWith(0), pr, headSha);
    expect(result.reason).toContain(headSha.slice(0, 7));
  });

  it("webhook-miss denial reason includes the PR number", () => {
    const result = evaluateCheckRunsPresence(okWith(0), "9999", headSha);
    expect(result.reason).toContain("#9999");
  });

  it("denies merge with a distinct reason on API failure (not the webhook-miss text)", () => {
    const result = evaluateCheckRunsPresence(
      failWith("gh api exited 1: 502 Bad Gateway"),
      pr,
      headSha
    );
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("Unable to query CI check_runs");
    expect(result.reason).toContain("gh api transport/parse failure");
    expect(result.reason).not.toContain("mt#1309 / PR #763 lineage");
    expect(result.reason).not.toContain("empty commit");
  });

  it("API-failure denial reason embeds the parser error verbatim", () => {
    const result = evaluateCheckRunsPresence(
      failWith("gh api returned empty response"),
      pr,
      headSha
    );
    expect(result.reason).toContain("gh api returned empty response");
  });

  it("API-failure denial reason still references /review-pr step 7a as the last-resort fallback", () => {
    const result = evaluateCheckRunsPresence(
      failWith("gh api exited 401: bad credentials"),
      pr,
      headSha
    );
    expect(result.reason).toContain("/review-pr step 7a");
  });

  it("API-failure denial reason includes the PR number and short HEAD sha", () => {
    const result = evaluateCheckRunsPresence(
      failWith("gh api exited 1: connection refused"),
      "9999",
      headSha
    );
    expect(result.reason).toContain("#9999");
    expect(result.reason).toContain(headSha.slice(0, 7));
  });
});

import { describe, expect, it } from "bun:test";
import { evaluateCheckRunsPresence } from "./require-review-before-merge";

describe("evaluateCheckRunsPresence (mt#1309)", () => {
  const pr = "855";
  const headSha = "3f1b048c486e1f49f26db71836b86b3ee4eb026d";

  it("allows merge when at least one check_run fired", () => {
    const result = evaluateCheckRunsPresence(2, pr, headSha);
    expect(result.deny).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("allows merge with a single check_run", () => {
    expect(evaluateCheckRunsPresence(1, pr, headSha).deny).toBe(false);
  });

  it("denies merge when zero check_runs fired (the webhook-miss class)", () => {
    const result = evaluateCheckRunsPresence(0, pr, headSha);
    expect(result.deny).toBe(true);
    expect(result.reason).toBeDefined();
  });

  it("denial reason names mt#1309 and PR #763 lineage", () => {
    const result = evaluateCheckRunsPresence(0, pr, headSha);
    expect(result.reason).toContain("mt#1309");
    expect(result.reason).toContain("PR #763");
  });

  it("denial reason points at the empty-commit recovery path", () => {
    const result = evaluateCheckRunsPresence(0, pr, headSha);
    expect(result.reason).toContain("empty commit");
    expect(result.reason).toContain("noFiles");
    expect(result.reason).toContain("noStage");
  });

  it("denial reason references /review-pr step 7a as the bypass-merge fallback", () => {
    const result = evaluateCheckRunsPresence(0, pr, headSha);
    expect(result.reason).toContain("/review-pr step 7a");
  });

  it("denial reason includes the short HEAD sha for triage", () => {
    const result = evaluateCheckRunsPresence(0, pr, headSha);
    expect(result.reason).toContain(headSha.slice(0, 7));
  });

  it("denial reason includes the PR number", () => {
    const result = evaluateCheckRunsPresence(0, "9999", headSha);
    expect(result.reason).toContain("#9999");
  });
});

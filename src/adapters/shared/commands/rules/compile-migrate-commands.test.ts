/**
 * Unit tests for `reportSingleTargetCompile` (mt#2874 R1 — this function
 * previously had ZERO direct unit tests despite four distinct branches:
 * stale, aggregate-budget-exceeded, per-rule-ceiling-exceeded (mt#2874 new),
 * and the non-check warn-only path).
 *
 * Scope: only the LOG/DECIDE logic in `reportSingleTargetCompile` — no CLI
 * process spawning, no filesystem. `CompileRulesResult` fixtures are
 * constructed directly.
 */
import { describe, test, expect } from "bun:test";
import { reportSingleTargetCompile } from "./compile-migrate-commands";
import type { CompileRulesResult } from "@minsky/domain/rules/rules-command-operations";

function makeResult(overrides: Partial<CompileRulesResult> = {}): CompileRulesResult {
  return {
    success: true,
    target: "claude.md",
    ...overrides,
  };
}

describe("reportSingleTargetCompile", () => {
  test("returns undefined (no failure) when not in --check mode", () => {
    const result = makeResult({ check: false });
    expect(reportSingleTargetCompile("claude.md", result)).toBeUndefined();
  });

  test("returns undefined when --check mode passes cleanly (no stale, no violations)", () => {
    const result = makeResult({
      check: true,
      stale: false,
      sizeChars: 100_000,
      sizeBudgetStatus: "ok",
      perRuleViolations: [],
    });
    expect(reportSingleTargetCompile("claude.md", result)).toBeUndefined();
  });

  describe("staleness branch", () => {
    test("returns a failure descriptor naming the stale file when --check + stale", () => {
      const result = makeResult({ check: true, stale: true, staleFile: "/repo/CLAUDE.md" });
      const failure = reportSingleTargetCompile("claude.md", result);
      expect(failure).toContain('target "claude.md" is stale');
      expect(failure).toContain("/repo/CLAUDE.md");
    });

    test("staleness takes precedence over a simultaneous per-rule-ceiling violation", () => {
      // Should not occur in practice (compileRules doesn't populate both at
      // once), but the reporting function's own precedence must still favor
      // staleness — matching classifyCompileCheckError's documented order
      // (mt#2874 R1: staleness > aggregate > per-rule).
      const result = makeResult({
        check: true,
        stale: true,
        staleFile: "/repo/CLAUDE.md",
        perRuleViolations: [{ id: "oversized-rule", size: 20_000 }],
      });
      const failure = reportSingleTargetCompile("claude.md", result);
      expect(failure).toContain("is stale");
      expect(failure).not.toContain("per-rule ceiling");
    });
  });

  describe("aggregate size-budget branch (mt#2802)", () => {
    test("returns a failure descriptor naming the size and threshold when --check + budget fail", () => {
      const result = makeResult({
        check: true,
        stale: false,
        sizeChars: 145_000,
        sizeBudget: { warnChars: 115_000, failChars: 140_000 },
        sizeBudgetStatus: "fail",
        topContributors: [{ id: "decision-defaults", size: 36_421 }],
      });
      const failure = reportSingleTargetCompile("claude.md", result);
      expect(failure).toContain("exceeds size budget");
      expect(failure).toContain("145000 > 140000");
    });

    test("aggregate-budget-exceeded takes precedence over a simultaneous per-rule-ceiling violation", () => {
      const result = makeResult({
        check: true,
        stale: false,
        sizeChars: 145_000,
        sizeBudget: { warnChars: 115_000, failChars: 140_000 },
        sizeBudgetStatus: "fail",
        perRuleViolations: [{ id: "oversized-rule", size: 20_000 }],
      });
      const failure = reportSingleTargetCompile("claude.md", result);
      expect(failure).toContain("exceeds size budget");
      expect(failure).not.toContain("per-rule ceiling");
    });
  });

  describe("per-rule-ceiling branch (mt#2874)", () => {
    test("returns a failure descriptor naming the violating rule when --check + perRuleViolations non-empty", () => {
      const result = makeResult({
        check: true,
        stale: false,
        sizeBudgetStatus: "ok",
        perRuleViolations: [{ id: "hook-files", size: 15_868 }],
      });
      const failure = reportSingleTargetCompile("claude.md", result);
      expect(failure).toContain('target "claude.md" has rule(s) exceeding the per-rule ceiling');
      expect(failure).toContain("hook-files (15868 chars)");
    });

    test("names ALL violating rules, not just the first, when multiple rules exceed the ceiling", () => {
      const result = makeResult({
        check: true,
        stale: false,
        sizeBudgetStatus: "ok",
        perRuleViolations: [
          { id: "rule-a", size: 16_000 },
          { id: "rule-b", size: 17_500 },
        ],
      });
      const failure = reportSingleTargetCompile("claude.md", result);
      expect(failure).toContain("rule-a (16000 chars)");
      expect(failure).toContain("rule-b (17500 chars)");
    });

    test("is NOT reachable when perRuleViolations is an empty array (aggregate + per-rule both pass)", () => {
      const result = makeResult({
        check: true,
        stale: false,
        sizeBudgetStatus: "ok",
        perRuleViolations: [],
      });
      expect(reportSingleTargetCompile("claude.md", result)).toBeUndefined();
    });

    test("is NOT reachable when perRuleViolations is undefined (target opted out, e.g. agents.md)", () => {
      const result = makeResult({
        check: true,
        stale: false,
        sizeBudgetStatus: "ok",
        perRuleViolations: undefined,
      });
      expect(reportSingleTargetCompile("agents.md", result)).toBeUndefined();
    });

    test("does not fire outside --check mode even when perRuleViolations is populated", () => {
      const result = makeResult({
        check: false,
        perRuleViolations: [{ id: "hook-files", size: 15_868 }],
      });
      expect(reportSingleTargetCompile("claude.md", result)).toBeUndefined();
    });
  });

  describe("non-check warn-only branch (mt#2802 criterion #6)", () => {
    test("never fails (returns undefined) when not in --check mode, even over the fail threshold", () => {
      const result = makeResult({
        check: false,
        sizeChars: 145_000,
        sizeBudget: { warnChars: 115_000, failChars: 140_000 },
        sizeBudgetStatus: "fail",
      });
      expect(reportSingleTargetCompile("claude.md", result)).toBeUndefined();
    });
  });
});

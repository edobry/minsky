/**
 * Unit tests for the compiled-output size budget (mt#2802).
 *
 * Covers: threshold resolution/override merging, threshold-comparison
 * classification (ok/warn/fail boundaries), per-rule contribution
 * computation, top-N contributor ranking, and the full evaluation pipeline.
 */
import { describe, it, expect } from "bun:test";
import {
  resolveSizeBudget,
  evaluateSizeBudgetStatus,
  computeRuleContributions,
  topContributors,
  evaluateSizeBudget,
  formatTopContributors,
  TOP_CONTRIBUTOR_COUNT,
  type SizeBudget,
} from "./size-budget";
import { makeRule } from "./test-utils";

const DEFAULT_BUDGET: SizeBudget = { warnChars: 1000, failChars: 2000 };

describe("resolveSizeBudget()", () => {
  it("returns the default budget when no override is supplied", () => {
    const budget = resolveSizeBudget(DEFAULT_BUDGET);
    expect(budget).toEqual(DEFAULT_BUDGET);
  });

  it("returns the default budget when override is an empty object", () => {
    const budget = resolveSizeBudget(DEFAULT_BUDGET, {});
    expect(budget).toEqual(DEFAULT_BUDGET);
  });

  it("overrides only warnChars when only warnChars is supplied", () => {
    const budget = resolveSizeBudget(DEFAULT_BUDGET, { warnChars: 500 });
    expect(budget).toEqual({ warnChars: 500, failChars: 2000 });
  });

  it("overrides only failChars when only failChars is supplied", () => {
    const budget = resolveSizeBudget(DEFAULT_BUDGET, { failChars: 5000 });
    expect(budget).toEqual({ warnChars: 1000, failChars: 5000 });
  });

  it("overrides both fields when both are supplied", () => {
    const budget = resolveSizeBudget(DEFAULT_BUDGET, { warnChars: 10, failChars: 20 });
    expect(budget).toEqual({ warnChars: 10, failChars: 20 });
  });
});

describe("evaluateSizeBudgetStatus()", () => {
  it("classifies a size well below warnChars as ok", () => {
    expect(evaluateSizeBudgetStatus(100, DEFAULT_BUDGET)).toBe("ok");
  });

  it("classifies a size one below warnChars as ok (boundary)", () => {
    expect(evaluateSizeBudgetStatus(999, DEFAULT_BUDGET)).toBe("ok");
  });

  it("classifies a size exactly at warnChars as warn (boundary, inclusive)", () => {
    expect(evaluateSizeBudgetStatus(1000, DEFAULT_BUDGET)).toBe("warn");
  });

  it("classifies a size between warnChars and failChars as warn", () => {
    expect(evaluateSizeBudgetStatus(1500, DEFAULT_BUDGET)).toBe("warn");
  });

  it("classifies a size one below failChars as warn (boundary)", () => {
    expect(evaluateSizeBudgetStatus(1999, DEFAULT_BUDGET)).toBe("warn");
  });

  it("classifies a size exactly at failChars as fail (boundary, inclusive)", () => {
    expect(evaluateSizeBudgetStatus(2000, DEFAULT_BUDGET)).toBe("fail");
  });

  it("classifies a size well above failChars as fail", () => {
    expect(evaluateSizeBudgetStatus(10_000, DEFAULT_BUDGET)).toBe("fail");
  });

  it("classifies zero as ok for a budget with positive thresholds", () => {
    expect(evaluateSizeBudgetStatus(0, DEFAULT_BUDGET)).toBe("ok");
  });
});

describe("computeRuleContributions()", () => {
  it("computes trimmed content length for each included rule", () => {
    const rules = [
      makeRule("rule-a", "  content A  "), // trims to "content A" (9 chars)
      makeRule("rule-b", "content BB"), // 10 chars
      makeRule("rule-c", "not included"),
    ];

    const contributions = computeRuleContributions(rules, ["rule-a", "rule-b"]);

    expect(contributions).toEqual([
      { id: "rule-a", size: 9 },
      { id: "rule-b", size: 10 },
    ]);
  });

  it("preserves includedIds order", () => {
    const rules = [makeRule("rule-a", "aaa"), makeRule("rule-b", "bb")];
    const contributions = computeRuleContributions(rules, ["rule-b", "rule-a"]);
    expect(contributions.map((c) => c.id)).toEqual(["rule-b", "rule-a"]);
  });

  it("silently skips ids not present in rules", () => {
    const rules = [makeRule("rule-a", "aaa")];
    const contributions = computeRuleContributions(rules, ["rule-a", "missing-rule"]);
    expect(contributions).toEqual([{ id: "rule-a", size: 3 }]);
  });

  it("returns an empty array for empty includedIds", () => {
    const rules = [makeRule("rule-a", "aaa")];
    expect(computeRuleContributions(rules, [])).toEqual([]);
  });

  it("returns an empty array for empty rules", () => {
    expect(computeRuleContributions([], ["rule-a"])).toEqual([]);
  });
});

describe("topContributors()", () => {
  const contributions = [
    { id: "small", size: 10 },
    { id: "biggest", size: 1000 },
    { id: "medium", size: 500 },
    { id: "tiny", size: 1 },
    { id: "large", size: 800 },
    { id: "medium-2", size: 400 },
  ];

  it("ranks by size descending", () => {
    const top = topContributors(contributions, 3);
    expect(top.map((c) => c.id)).toEqual(["biggest", "large", "medium"]);
  });

  it("defaults to TOP_CONTRIBUTOR_COUNT (5) when count is omitted", () => {
    const top = topContributors(contributions);
    expect(top).toHaveLength(TOP_CONTRIBUTOR_COUNT);
    expect(top.map((c) => c.id)).toEqual(["biggest", "large", "medium", "medium-2", "small"]);
  });

  it("returns all contributions when count exceeds the input length", () => {
    const top = topContributors(contributions, 100);
    expect(top).toHaveLength(contributions.length);
  });

  it("returns an empty array for empty input", () => {
    expect(topContributors([], 5)).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [
      { id: "a", size: 1 },
      { id: "b", size: 2 },
    ];
    const copy = [...input];
    topContributors(input, 1);
    expect(input).toEqual(copy);
  });
});

describe("evaluateSizeBudget()", () => {
  const rules = [
    makeRule("big-rule", "x".repeat(1200)),
    makeRule("small-rule", "y".repeat(100)),
    makeRule("excluded-rule", "z".repeat(5000)), // not in includedIds
  ];

  it("computes sizeChars, budget, status, and topContributors together", () => {
    const evaluation = evaluateSizeBudget({
      sizeChars: 1300,
      rules,
      includedIds: ["big-rule", "small-rule"],
      defaultBudget: DEFAULT_BUDGET,
    });

    expect(evaluation.sizeChars).toBe(1300);
    expect(evaluation.budget).toEqual(DEFAULT_BUDGET);
    expect(evaluation.status).toBe("warn"); // 1300 >= warnChars(1000), < failChars(2000)
    expect(evaluation.topContributors).toEqual([
      { id: "big-rule", size: 1200 },
      { id: "small-rule", size: 100 },
    ]);
    // The excluded rule must not appear even though it is much larger.
    expect(evaluation.topContributors.some((c) => c.id === "excluded-rule")).toBe(false);
  });

  it("applies a per-call override to the resolved budget", () => {
    const evaluation = evaluateSizeBudget({
      sizeChars: 1300,
      rules,
      includedIds: ["big-rule", "small-rule"],
      defaultBudget: DEFAULT_BUDGET,
      override: { failChars: 1300 },
    });

    expect(evaluation.budget).toEqual({ warnChars: 1000, failChars: 1300 });
    expect(evaluation.status).toBe("fail");
  });

  it("classifies as ok when sizeChars is below the warn threshold", () => {
    const evaluation = evaluateSizeBudget({
      sizeChars: 50,
      rules,
      includedIds: ["small-rule"],
      defaultBudget: DEFAULT_BUDGET,
    });

    expect(evaluation.status).toBe("ok");
  });
});

describe("formatTopContributors()", () => {
  it("formats a ranked list with 1-based numbering and chars label", () => {
    const lines = formatTopContributors([
      { id: "decision-defaults", size: 36421 },
      { id: "hook-files", size: 24000 },
    ]);

    expect(lines).toEqual(["1. decision-defaults (36421 chars)", "2. hook-files (24000 chars)"]);
  });

  it("formats an empty list as an empty array", () => {
    expect(formatTopContributors([])).toEqual([]);
  });
});

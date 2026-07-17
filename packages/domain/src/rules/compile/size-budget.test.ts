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
  findPerRuleCeilingViolations,
  TOP_CONTRIBUTOR_COUNT,
  DEFAULT_PER_RULE_CEILING_CHARS,
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

  it("throws when the resolved warnChars equals or exceeds failChars", () => {
    expect(() => resolveSizeBudget({ warnChars: 2000, failChars: 2000 })).toThrow(
      /strictly less than/
    );
    expect(() =>
      resolveSizeBudget(DEFAULT_BUDGET, { warnChars: DEFAULT_BUDGET.failChars + 1 })
    ).toThrow(/strictly less than/);
  });

  it("throws when an override inverts the ordering against the other default field", () => {
    // failChars override drops below the default warnChars (1000)
    expect(() => resolveSizeBudget(DEFAULT_BUDGET, { failChars: 999 })).toThrow(
      /strictly less than/
    );
  });

  it("throws on non-positive or non-finite thresholds", () => {
    expect(() => resolveSizeBudget({ warnChars: 0, failChars: 100 })).toThrow(/positive finite/);
    expect(() => resolveSizeBudget({ warnChars: -5, failChars: 100 })).toThrow(/positive finite/);
    expect(() => resolveSizeBudget(DEFAULT_BUDGET, { failChars: Number.NaN })).toThrow(
      /positive finite/
    );
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
    // ruleContentChars sums ALL included contributions (1200 + 100), so the
    // remainder vs sizeChars is attributable to target scaffolding.
    expect(evaluation.ruleContentChars).toBe(1300);
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

describe("findPerRuleCeilingViolations() (mt#2874)", () => {
  it("returns empty when no alwaysApply rule exceeds the ceiling", () => {
    const rules = [
      makeRule("always-small", "x".repeat(100), { alwaysApply: true }),
      makeRule("always-medium", "y".repeat(14_000), { alwaysApply: true }),
    ];
    const violations = findPerRuleCeilingViolations(
      rules,
      ["always-small", "always-medium"],
      15_000
    );
    expect(violations).toEqual([]);
  });

  it("flags an alwaysApply rule whose contribution STRICTLY exceeds the ceiling", () => {
    const rules = [makeRule("always-huge", "z".repeat(15_001), { alwaysApply: true })];
    const violations = findPerRuleCeilingViolations(rules, ["always-huge"], 15_000);
    expect(violations).toEqual([{ id: "always-huge", size: 15_001 }]);
  });

  it("boundary: a rule exactly AT the ceiling does not violate", () => {
    const rules = [makeRule("always-exact", "a".repeat(15_000), { alwaysApply: true })];
    const violations = findPerRuleCeilingViolations(rules, ["always-exact"], 15_000);
    expect(violations).toEqual([]);
  });

  it("boundary: a rule one char OVER the ceiling violates", () => {
    const rules = [makeRule("always-over", "a".repeat(15_001), { alwaysApply: true })];
    const violations = findPerRuleCeilingViolations(rules, ["always-over"], 15_000);
    expect(violations).toEqual([{ id: "always-over", size: 15_001 }]);
  });

  it("ignores a NON-alwaysApply rule even when it exceeds the ceiling", () => {
    const rules = [
      makeRule("glob-scoped-huge", "b".repeat(20_000), { alwaysApply: false, globs: ["**/*.ts"] }),
    ];
    const violations = findPerRuleCeilingViolations(rules, ["glob-scoped-huge"], 15_000);
    expect(violations).toEqual([]);
  });

  it("only considers rules present in includedIds", () => {
    const rules = [makeRule("excluded-huge", "c".repeat(20_000), { alwaysApply: true })];
    const violations = findPerRuleCeilingViolations(rules, [], 15_000);
    expect(violations).toEqual([]);
  });

  it("ranks multiple violations by size descending", () => {
    const rules = [
      makeRule("medium-violator", "d".repeat(16_000), { alwaysApply: true }),
      makeRule("big-violator", "e".repeat(18_000), { alwaysApply: true }),
    ];
    const violations = findPerRuleCeilingViolations(
      rules,
      ["medium-violator", "big-violator"],
      15_000
    );
    expect(violations.map((v) => v.id)).toEqual(["big-violator", "medium-violator"]);
  });

  it("defaults to DEFAULT_PER_RULE_CEILING_CHARS (15,000) when no ceiling is passed", () => {
    const rules = [makeRule("always-huge", "f".repeat(15_001), { alwaysApply: true })];
    const violations = findPerRuleCeilingViolations(rules, ["always-huge"]);
    expect(violations).toEqual([{ id: "always-huge", size: 15_001 }]);
    expect(DEFAULT_PER_RULE_CEILING_CHARS).toBe(15_000);
  });
});

describe("evaluateSizeBudget() — perRuleCeiling integration (mt#2874)", () => {
  it("omits perRuleViolations computation entirely when perRuleCeiling is not supplied", () => {
    const rules = [makeRule("always-huge", "g".repeat(20_000), { alwaysApply: true })];
    const evaluation = evaluateSizeBudget({
      sizeChars: 20_000,
      rules,
      includedIds: ["always-huge"],
      defaultBudget: { warnChars: 100_000, failChars: 200_000 },
    });
    expect(evaluation.perRuleViolations).toEqual([]);
  });

  it("populates perRuleViolations when perRuleCeiling is supplied and exceeded", () => {
    const rules = [makeRule("always-huge", "h".repeat(20_000), { alwaysApply: true })];
    const evaluation = evaluateSizeBudget({
      sizeChars: 20_000,
      rules,
      includedIds: ["always-huge"],
      defaultBudget: { warnChars: 100_000, failChars: 200_000 },
      perRuleCeiling: 15_000,
    });
    expect(evaluation.perRuleViolations).toEqual([{ id: "always-huge", size: 20_000 }]);
    // The aggregate budget (100K warn / 200K fail) independently passes —
    // per-rule and aggregate checks are orthogonal (mt#2874 spec).
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

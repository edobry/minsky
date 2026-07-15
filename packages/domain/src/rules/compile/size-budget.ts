/**
 * Compiled-output size budget (mt#2802)
 *
 * Adds a size budget to the legacy `rules compile` pipeline's monolithic
 * targets (`claude.md`, `agents.md`). Every compile reports the output size
 * in characters; `--check` mode enforces warn/fail thresholds so an
 * operator gets an early, actionable signal before the corpus silently
 * regrows past Claude Code's advisory truncation-adjacent thresholds.
 *
 * Scope: this module is deliberately generic (no target-specific defaults
 * live here) — each target (`claude-md.ts`, `agents-md.ts`) owns its own
 * default budget constant and calls into this module's pure functions to
 * evaluate it. `cursor-rules.ts` (multi-file, per-rule output) does not use
 * this module — the size budget applies to monolithic single-file targets
 * only, per the mt#2802 spec.
 */

import type { Rule } from "../types";

/** Warn/fail thresholds for a compile target's output size, in characters. */
export interface SizeBudget {
  /** Output size (chars) at or above which a WARN is reported. */
  warnChars: number;
  /** Output size (chars) at or above which `--check` mode hard-fails. */
  failChars: number;
}

/** A single rule's contribution to a compiled target's output size. */
export interface RuleContribution {
  id: string;
  /** Size (chars) of this rule's trimmed content as emitted into the output. */
  size: number;
}

export type SizeBudgetStatus = "ok" | "warn" | "fail";

export interface SizeBudgetEvaluation {
  sizeChars: number;
  budget: SizeBudget;
  status: SizeBudgetStatus;
  /** Rules ranked by compiled contribution size, descending (top N only). */
  topContributors: RuleContribution[];
  /**
   * Total chars of ALL included rules' emitted content (not just the top N);
   * the remainder of `sizeChars` is target scaffolding (banner, headers,
   * section preamble). Lets messages attribute overage honestly.
   */
  ruleContentChars: number;
}

/** Number of top contributors to report in a budget message (mt#2802 spec). */
export const TOP_CONTRIBUTOR_COUNT = 5;

/**
 * Resolve the effective budget for a compile, merging a target's default
 * with any per-call override (from `TargetOptions.sizeBudget`). Either
 * field of the override may be supplied independently.
 */
export function resolveSizeBudget(
  defaultBudget: SizeBudget,
  override?: Partial<SizeBudget>
): SizeBudget {
  const resolved = {
    warnChars: override?.warnChars ?? defaultBudget.warnChars,
    failChars: override?.failChars ?? defaultBudget.failChars,
  };
  if (
    !Number.isFinite(resolved.warnChars) ||
    !Number.isFinite(resolved.failChars) ||
    resolved.warnChars <= 0 ||
    resolved.failChars <= 0
  ) {
    throw new Error(
      `Invalid size budget: thresholds must be positive finite numbers ` +
        `(warnChars=${resolved.warnChars}, failChars=${resolved.failChars})`
    );
  }
  if (resolved.warnChars >= resolved.failChars) {
    throw new Error(
      `Invalid size budget: warnChars (${resolved.warnChars}) must be strictly less than ` +
        `failChars (${resolved.failChars}) — a warn threshold at or above fail would ` +
        `misclassify overages`
    );
  }
  return resolved;
}

/**
 * Classify a compiled size against a budget. A size at or above
 * `failChars` classifies as `"fail"` even if it would also satisfy the
 * `"warn"` condition — fail takes precedence.
 */
export function evaluateSizeBudgetStatus(sizeChars: number, budget: SizeBudget): SizeBudgetStatus {
  if (sizeChars >= budget.failChars) return "fail";
  if (sizeChars >= budget.warnChars) return "warn";
  return "ok";
}

/**
 * Rank rule contributions by size, descending, and return the top `count`
 * (defaults to {@link TOP_CONTRIBUTOR_COUNT}). Does not mutate the input.
 */
export function topContributors(
  contributions: RuleContribution[],
  count: number = TOP_CONTRIBUTOR_COUNT
): RuleContribution[] {
  return [...contributions].sort((a, b) => b.size - a.size).slice(0, count);
}

/**
 * Build the per-rule contribution list for a target's compiled output: the
 * trimmed content size of each *included* rule, matching what the target's
 * content builder actually emits (`rule.content.trim()`). Rule ids not
 * found in `rules` are silently skipped (defensive — should not happen in
 * practice since `includedIds` is derived from the same `rules` array).
 */
export function computeRuleContributions(rules: Rule[], includedIds: string[]): RuleContribution[] {
  const ruleMap = new Map(rules.map((r) => [r.id, r] as const));
  const contributions: RuleContribution[] = [];
  for (const id of includedIds) {
    const rule = ruleMap.get(id);
    if (!rule) continue;
    contributions.push({ id, size: rule.content.trim().length });
  }
  return contributions;
}

/**
 * Full evaluation: resolve the effective budget, classify the compiled
 * size, and rank the top contributors for a fail/warn message.
 */
export function evaluateSizeBudget(params: {
  sizeChars: number;
  rules: Rule[];
  includedIds: string[];
  defaultBudget: SizeBudget;
  override?: Partial<SizeBudget>;
}): SizeBudgetEvaluation {
  const budget = resolveSizeBudget(params.defaultBudget, params.override);
  const status = evaluateSizeBudgetStatus(params.sizeChars, budget);
  const contributions = computeRuleContributions(params.rules, params.includedIds);
  return {
    sizeChars: params.sizeChars,
    budget,
    status,
    topContributors: topContributors(contributions),
    ruleContentChars: contributions.reduce((sum, c) => sum + c.size, 0),
  };
}

/**
 * Format a ranked contribution list as human-readable lines, e.g.
 * `"1. decision-defaults (36421 chars)"`. Used for both the `--check`
 * fail message and the non-check WARN message.
 */
export function formatTopContributors(contributions: RuleContribution[]): string[] {
  return contributions.map((c, i) => `${i + 1}. ${c.id} (${c.size} chars)`);
}

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
  /**
   * `alwaysApply: true` rules (mt#2874) whose OWN compiled contribution
   * exceeds the per-rule ceiling, ranked by size descending. Empty when no
   * `perRuleCeiling` was supplied to `evaluateSizeBudget` (the default) —
   * this is an OPT-IN sibling check, not a replacement for the aggregate
   * `status` above: a target can pass the aggregate budget while still
   * having one oversized always-on rule (or vice versa).
   */
  perRuleViolations: RuleContribution[];
}

/** Number of top contributors to report in a budget message (mt#2802 spec). */
export const TOP_CONTRIBUTOR_COUNT = 5;

/**
 * Default per-rule ceiling (chars) for a single `alwaysApply: true` rule's
 * compiled contribution (mt#2874). Makes mt#1877's per-rule 15KB budget
 * (previously spec-memory only) mechanical: `rules compile --check` fails
 * and NAMES the rule when any always-on rule's own trimmed content exceeds
 * this many chars, independent of whether the target's AGGREGATE budget
 * (`SizeBudget` above) also fails. A rule "exceeds" the ceiling only when
 * its size is STRICTLY GREATER than this value — exactly at the ceiling is
 * not yet an overage (mirrors the sibling growth-justification gate's
 * `> GROWTH_THRESHOLD_CHARS` boundary, mt#2874).
 */
export const DEFAULT_PER_RULE_CEILING_CHARS = 15_000;

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
 * Find `alwaysApply: true` rules among `includedIds` whose compiled
 * contribution STRICTLY EXCEEDS `ceilingChars` (mt#2874). Only rules with
 * `alwaysApply === true` are considered — a large glob-scoped or
 * agent-requested rule contributes to the AGGREGATE budget but was never
 * the always-loaded-context hazard this per-rule ceiling exists to catch
 * (the same scoping the mt#2874 spec's ladder discipline targets: content
 * that isn't `alwaysApply` already sits on a cheaper channel). Ranked by
 * size descending, matching `topContributors`' ordering convention.
 *
 * Edge case (R1 clarification): for the `claude.md` target specifically,
 * this `alwaysApply` filter is DEFENSIVE, not load-bearing in practice —
 * `buildClaudeMdContent` (`targets/claude-md.ts`) already restricts its
 * `rulesIncluded` output to `alwaysApply: true` rules by construction ("By
 * default, only includes ALWAYS_APPLY rules" per that file's own module
 * doc), so a glob-scoped or agent-requested rule never appears in the
 * `includedIds` this function receives from the `claude.md` call site at
 * all — it doesn't compile into `claude.md`, so there is nothing for this
 * filter to need to exclude there. The `alwaysApply === true` check earns
 * its keep as a CORRECTNESS GUARANTEE for this function's general
 * reusability: any FUTURE caller (a different target, a test fixture that
 * passes a broader `includedIds` set) is still protected from
 * misclassifying a non-always-on rule as a per-rule-ceiling violation.
 */
export function findPerRuleCeilingViolations(
  rules: Rule[],
  includedIds: string[],
  ceilingChars: number = DEFAULT_PER_RULE_CEILING_CHARS
): RuleContribution[] {
  const alwaysApplyIds = new Set(rules.filter((r) => r.alwaysApply === true).map((r) => r.id));
  const contributions = computeRuleContributions(
    rules,
    includedIds.filter((id) => alwaysApplyIds.has(id))
  );
  return contributions.filter((c) => c.size > ceilingChars).sort((a, b) => b.size - a.size);
}

/**
 * Full evaluation: resolve the effective budget, classify the compiled
 * size, rank the top contributors for a fail/warn message, and — when
 * `perRuleCeiling` is supplied — find any `alwaysApply: true` rule whose
 * own contribution exceeds it (mt#2874). Omitting `perRuleCeiling` skips
 * that computation entirely (empty `perRuleViolations`), so callers that
 * don't want the per-rule check (e.g. targets other than `claude.md`) pay
 * no extra cost.
 */
export function evaluateSizeBudget(params: {
  sizeChars: number;
  rules: Rule[];
  includedIds: string[];
  defaultBudget: SizeBudget;
  override?: Partial<SizeBudget>;
  /** Opt-in per-rule ceiling (chars). See `findPerRuleCeilingViolations`. */
  perRuleCeiling?: number;
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
    perRuleViolations:
      params.perRuleCeiling !== undefined
        ? findPerRuleCeilingViolations(params.rules, params.includedIds, params.perRuleCeiling)
        : [],
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

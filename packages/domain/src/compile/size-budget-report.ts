/**
 * Size-budget extension fields + shared CLI reporter for the new `compile`
 * pipeline's monolithic single-file targets (`claude.md`, `agents.md` —
 * mt#2992).
 *
 * **Why a narrower extension type instead of widening `MinskyCompileResult`
 * (mt#2992 spec):** only `claude.md`/`agents.md` evaluate a size budget;
 * `claude-skills`, `claude-agents`, `cursor-rules-ts`, `claude-hooks`, and
 * the new `claude-rules` target have no notion of one. Widening the shared
 * `MinskyCompileResult` interface for a concern only two of seven targets
 * care about would force every OTHER target's result to either populate
 * irrelevant fields or leave a type-claimed field silently undefined.
 * Instead, `MinskyMonolithicCompileResult` is a strict superset consumers opt
 * into via `hasSizeBudgetFields` — mirroring how the legacy CLI's
 * `reportSingleTargetCompile` (`compile-migrate-commands.ts`) already probes
 * `result.sizeChars !== undefined` (there, only because legacy's shared
 * `CompileResult` type WAS widened for all targets; here, the same
 * probe-before-use discipline substitutes for that widening).
 */

import type { MinskyCompileResult } from "./types";
import {
  formatTopContributors,
  type SizeBudget,
  type SizeBudgetStatus,
  type RuleContribution,
} from "./size-budget";

/** Size-budget fields the monolithic targets (`claude.md`, `agents.md`) add. */
export interface MonolithicSizeFields {
  sizeChars: number;
  sizeBudget: SizeBudget;
  sizeBudgetStatus: SizeBudgetStatus;
  topContributors: RuleContribution[];
  ruleContentChars: number;
  /**
   * `alwaysApply: true` rules whose own compiled contribution exceeds the
   * per-rule ceiling (mt#2874). Only ever populated for `claude.md` — see
   * `evaluateSizeBudget`'s `perRuleCeiling` param.
   */
  perRuleViolations: RuleContribution[];
}

/** A `MinskyCompileResult` carrying the monolithic size-budget fields. */
export type MinskyMonolithicCompileResult = MinskyCompileResult & MonolithicSizeFields;

/**
 * Narrow an arbitrary compile result to the monolithic size-budget shape at
 * the consumer boundary. `"sizeChars" in result` alone would satisfy an
 * index-signature-less TS type check on an `unknown`-shaped object, but the
 * value-presence check (`!== undefined`) is what actually distinguishes "this
 * target evaluated a budget" from "this field happens to be absent" —
 * matching the legacy `reportSingleTargetCompile`'s `result.sizeChars !==
 * undefined` probe this mirrors.
 */
export function hasSizeBudgetFields<T extends object>(
  result: T
): result is T & MonolithicSizeFields {
  return (result as Partial<MonolithicSizeFields>).sizeChars !== undefined;
}

/**
 * Emit size-budget diagnostics for one target's compile result and, in
 * `--check` mode, return a short failure descriptor when the target EXCEEDS
 * its aggregate budget or has a per-rule-ceiling violation — so the caller
 * can aggregate failures across multiple probed targets instead of throwing
 * on the first one found. Returns `undefined` when the target passed (or
 * when not in `--check` mode; non-check compiles never hard-fail on budget,
 * only warn).
 *
 * Shared between the new `compile` CLI's single-target and multi-target-loop
 * call sites (`compile-commands.ts`) so the exact marker strings
 * `classifyCompileCheckError` (`src/hooks/pre-commit.ts`) string-matches —
 * `"EXCEEDS SIZE BUDGET"` and `"HAS RULE(S) EXCEEDING PER-RULE CEILING"` —
 * are emitted from exactly one place. Deliberately a SEPARATE function from
 * the legacy CLI's `reportSingleTargetCompile` (not a shared cross-CLI call)
 * — `compile-migrate-commands.ts` is out of scope for behavior changes in
 * mt#2992 (spec: "import repoints only").
 *
 * The `[compile ...]` marker prefix matches `classifyCompileCheckError`'s
 * `kind: "compile"` branch (`cmd = "compile"`) exactly — do not change this
 * prefix without updating that classifier.
 */
export function reportMonolithicSizeBudget(
  target: string,
  result: MonolithicSizeFields & { check?: boolean },
  logCli: (line: string) => void
): string | undefined {
  logCli(`[compile] Target "${target}" output size: ${result.sizeChars} chars`);

  // --check mode: report + fail when output exceeds its fail threshold.
  if (result.check && result.sizeBudgetStatus === "fail") {
    logCli(`[compile --check] Target "${target}" EXCEEDS SIZE BUDGET`);
    logCli(
      `  Size: ${result.sizeChars} chars (fail threshold: ${result.sizeBudget.failChars} chars)`
    );
    logCli(`  Top contributing rules:`);
    for (const line of formatTopContributors(result.topContributors)) {
      logCli(`    ${line}`);
    }
    logCli(
      `  (rule content: ${result.ruleContentChars} of ${result.sizeChars} chars; ` +
        `remainder is target scaffolding — banner/headers)`
    );
    logCli(`  Trim the rules above, or override via target options (--warn-chars/--fail-chars).`);
    return (
      `target "${target}" exceeds size budget ` +
      `(${result.sizeChars} > ${result.sizeBudget.failChars} chars)`
    );
  }

  // --check mode: report + fail when any alwaysApply:true rule's OWN compiled
  // contribution exceeds the per-rule ceiling (mt#2874). Independent of the
  // aggregate check above — a target can pass the aggregate budget while
  // still having one oversized always-on rule. Only reachable when the
  // aggregate check above did not already fail (same "fix the bigger problem
  // first" precedence the legacy reporter and classifyCompileCheckError use).
  if (result.check && result.perRuleViolations.length > 0) {
    logCli(`[compile --check] Target "${target}" HAS RULE(S) EXCEEDING PER-RULE CEILING`);
    for (const violation of result.perRuleViolations) {
      logCli(`  Rule "${violation.id}": ${violation.size} chars`);
    }
    logCli(`  Trim the rule(s) above.`);
    const violationsList = result.perRuleViolations.map((v) => `${v.id} (${v.size} chars)`);
    return `target "${target}" has rule(s) exceeding the per-rule ceiling: ${violationsList.join(", ")}`;
  }

  // Non-check compiles never fail on budget — warn loudly instead, for
  // either threshold crossed (warn or fail) since only --check hard-fails.
  if (!result.check && (result.sizeBudgetStatus === "warn" || result.sizeBudgetStatus === "fail")) {
    const thresholdChars =
      result.sizeBudgetStatus === "fail"
        ? result.sizeBudget.failChars
        : result.sizeBudget.warnChars;
    logCli(
      `[compile] WARNING: target "${target}" output (${result.sizeChars} chars) ` +
        `exceeds its ${result.sizeBudgetStatus} threshold (${thresholdChars} chars).`
    );
    logCli(`  Top contributing rules:`);
    for (const line of formatTopContributors(result.topContributors)) {
      logCli(`    ${line}`);
    }
  }

  return undefined;
}

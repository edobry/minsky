/**
 * CLAUDE.md Compile Target (new pipeline — mt#2992, Phase 1 of ADR-016
 * convergence)
 *
 * Ports the legacy `claude.md` target's content-assembly logic
 * (`packages/domain/src/rules/compile/targets/claude-md.ts`) onto the new
 * `compile` pipeline's rule source: `discoverRuleSources` /
 * `extractRuleDefinitionFromMdc` (`../rule-sources.ts`) via the shared
 * `loadAdaptedRules` loader (`./rule-loader.ts`), rather than the legacy
 * `RuleService`.
 *
 * **This target lands DORMANT** (mt#2992 spec) — registered in
 * `createMinskyCompileService()` and reachable only via explicit
 * `compile --target claude.md`. It is NOT added to
 * `minskyCompileTargetsFromPresence` or `compileCheckTargets` in this task;
 * legacy remains the authoritative CLAUDE.md writer until the cutover task
 * (mt#3058) flips them atomically.
 *
 * By default, only includes ALWAYS_APPLY rules. The `memory-usage` rule
 * (id: "memory-usage", tag: "memory") is always-apply by default, but is
 * suppressed when `memoryLoadingMode` is `"legacy"`, allowing a
 * soft-transition window where operators can fall back to MEMORY.md
 * preamble loading.
 *
 * **Ordering (spec `## Ordering`):** rules are embedded in the order
 * `loadAdaptedRules` returns them — the same alphabetical-by-source-name
 * order `discoverRuleSources` already sorts by. This is a DELIBERATE
 * divergence from legacy, which appends in unstable `readdir` order — see
 * the mt#2992 spec's `## Ordering` section for the full rationale.
 *
 * **Generation banner is NOT changed** (spec `## Scope`) — the literal HTML
 * comment below matches the legacy writer exactly, since
 * `check-generated-file-edit.ts` and both bare-invocation staleness probes
 * key off it. Duplicated as a literal here (not imported from the legacy
 * `rules/compile/targets/claude-md.ts`, which mt#2996 deletes) — the same
 * precedent `claude-rules.ts`'s `CLAUDE_RULES_BANNER` already establishes
 * for a banner shared across systems mid-migration.
 */

import { join } from "path";
import realFs from "fs/promises";
import { classifyRuleType, RuleType } from "../../rules/rule-classifier";
import type { Rule } from "../../rules/types";
import type { MinskyCompileTarget, MinskyTargetOptions, MinskyCompileFsDeps } from "../types";
import { evaluateSizeBudget, DEFAULT_PER_RULE_CEILING_CHARS } from "../size-budget";
import { DEFAULT_CLAUDE_MD_SIZE_BUDGET } from "../claude-md-size-budget";
import type { MinskyMonolithicCompileResult } from "../size-budget-report";
import { loadAdaptedRules, type SkipLogFn, type DynamicImportFn } from "./rule-loader";
import { createSkipRecorder } from "./skip-recorder";
import { MONOLITHIC_GENERATED_BANNER } from "../../rules/compile/banner-constants";
import { isForeignMonolith, foreignOutputSkipReason } from "../monolithic-ownership";

/** The canonical rule ID for the memory-usage directive. */
const MEMORY_USAGE_RULE_ID = "memory-usage";

/**
 * Matches the legacy `rules/compile/targets/claude-md.ts` banner exactly (see module doc).
 *
 * Now IMPORTED rather than re-declared (mt#4986): the ownership predicate that
 * decides whether an on-disk `CLAUDE.md` is ours reads the same constant, and a
 * third copy of the literal is exactly the drift `banner-constants.ts` exists
 * to prevent.
 */
const CLAUDE_MD_BANNER = MONOLITHIC_GENERATED_BANNER;

// `DEFAULT_CLAUDE_MD_SIZE_BUDGET` is imported (not declared here) so both
// compile pipelines share ONE constant and cannot drift again (mt#3075 — this
// dormant target's own copy had drifted to the pre-mt#3052/mt#3061 values,
// 115_000/140_000, because the legacy target's copy was updated and this one
// wasn't). See `../claude-md-size-budget.ts` for the full rationale behind
// the specific thresholds.
export { DEFAULT_CLAUDE_MD_SIZE_BUDGET };

function claudeMdOutputPath(workspacePath: string): string {
  return join(workspacePath, "CLAUDE.md");
}

/**
 * Build CLAUDE.md content from always-apply rules. Ports
 * `buildClaudeMdContent` from the legacy target 1:1 in behavior, operating
 * on the legacy-shaped `Rule[]` `loadAdaptedRules` produces.
 */
export function buildClaudeMdContent(
  allRules: Rule[],
  memoryLoadingMode: MinskyTargetOptions["memoryLoadingMode"] = "on_demand"
): {
  content: string;
  rulesIncluded: string[];
  rulesSkipped: string[];
} {
  const rulesIncluded: string[] = [];
  const rulesSkipped: string[] = [];

  const alwaysApplyRules: Rule[] = [];
  for (const rule of allRules) {
    const ruleType = classifyRuleType(rule);
    if (ruleType === RuleType.ALWAYS_APPLY) {
      if (memoryLoadingMode === "legacy" && rule.id === MEMORY_USAGE_RULE_ID) {
        rulesSkipped.push(rule.id);
        continue;
      }
      alwaysApplyRules.push(rule);
      rulesIncluded.push(rule.id);
    } else {
      rulesSkipped.push(rule.id);
    }
  }

  const lines: string[] = [];
  lines.push(CLAUDE_MD_BANNER);
  lines.push("");
  lines.push("# Project Instructions");
  lines.push("");

  for (const rule of alwaysApplyRules) {
    const content = rule.content.trim();
    if (content) {
      lines.push(content);
      lines.push("");
    }
  }

  return { content: lines.join("\n"), rulesIncluded, rulesSkipped };
}

/** Build the claude.md target, injecting fs/dynamicImport/skip-log for tests. */
function makeClaudeMdTarget(
  dynamicImport?: DynamicImportFn,
  onSkip?: SkipLogFn
): MinskyCompileTarget {
  return {
    id: "claude.md",
    displayName: "CLAUDE.md",

    defaultOutputPath(workspacePath: string): string {
      return claudeMdOutputPath(workspacePath);
    },

    async listOutputFiles(
      options: MinskyTargetOptions,
      workspacePath: string,
      fsDeps?: MinskyCompileFsDeps
    ): Promise<string[]> {
      const outputPath = options.outputPath || claudeMdOutputPath(workspacePath);
      // mt#4986 SC4. A foreign CLAUDE.md is not an output of ours, so this
      // target has none — which is what keeps `--check` from reporting the
      // user's own file stale. `checkStaleness` drives its whole comparison off
      // this list, so answering here is the one place that covers every caller;
      // returning the path and special-casing the comparison downstream would
      // leave the orphan sweep and any future consumer to rediscover the rule.
      return (await isForeignMonolith(outputPath, fsDeps)) ? [] : [outputPath];
    },

    async compile(
      options: MinskyTargetOptions,
      workspacePath: string,
      fsDeps?: MinskyCompileFsDeps
    ): Promise<MinskyMonolithicCompileResult> {
      const fs = fsDeps ?? (realFs as MinskyCompileFsDeps);
      // mt#3119: capture the loader's FAILURE skips so they reach the result.
      const { record: recordSkip, reasons: skipReasons } = createSkipRecorder(onSkip);
      const rules = await loadAdaptedRules(workspacePath, fs, recordSkip, dynamicImport);

      const { content, rulesIncluded, rulesSkipped } = buildClaudeMdContent(
        rules,
        options.memoryLoadingMode
      );

      // Evaluate BEFORE writing so the reported evaluation always describes
      // the exact content string being emitted (mirrors legacy R1 fix).
      const sizeEvaluation = evaluateSizeBudget({
        sizeChars: content.length,
        rules,
        includedIds: rulesIncluded,
        defaultBudget: DEFAULT_CLAUDE_MD_SIZE_BUDGET,
        override: options.sizeBudget,
        // mt#2874: per-rule 15K ceiling — claude.md only, per the spec's scope.
        perRuleCeiling: DEFAULT_PER_RULE_CEILING_CHARS,
      });

      const outputPath = options.outputPath || claudeMdOutputPath(workspacePath);
      const contentsByPath = new Map<string, string>([[outputPath, content]]);

      // mt#4986 SC1. The floor, and the reason it lives HERE rather than only in
      // target selection: `runMinskyCompile` returns early on an explicit
      // `--target claude.md` and never reaches the probe, so a selection-only
      // guard would leave the one invocation an operator reaches for by name
      // still destroying the file.
      if (await isForeignMonolith(outputPath, fs)) {
        return {
          target: "claude.md",
          filesWritten: [],
          // NOTHING was included: the output these rules would have gone into
          // was not written. Reporting them as `definitionsIncluded` would tell
          // `init`'s reachability accounting (`init.ts`, mt#4770) that four base
          // rules reached the agent when they reached nothing — the same
          // false-completion shape as listing an unwritten file in
          // `filesWritten`. The rules are all skipped, and the whole-file reason
          // is on `skippedForeignOutputs` rather than repeated per rule.
          definitionsIncluded: [],
          definitionsSkipped: [...rulesSkipped, ...rulesIncluded],
          skipReasons,
          skippedForeignOutputs: [
            { path: outputPath, reason: foreignOutputSkipReason(outputPath) },
          ],
          // `content` still describes what WOULD have been emitted, so a
          // dry-run caller can show it; `contentsByPath` stays empty because it
          // is what `--check` compares against on-disk files, and there is no
          // file of ours to compare.
          content: options.dryRun ? content : undefined,
          contentsByPath: options.dryRun ? new Map<string, string>() : undefined,
          sizeChars: sizeEvaluation.sizeChars,
          sizeBudget: sizeEvaluation.budget,
          sizeBudgetStatus: sizeEvaluation.status,
          topContributors: sizeEvaluation.topContributors,
          ruleContentChars: sizeEvaluation.ruleContentChars,
          perRuleViolations: sizeEvaluation.perRuleViolations,
        };
      }

      if (options.dryRun) {
        // no write
      } else {
        await fs.writeFile(outputPath, content, "utf-8");
      }

      return {
        target: "claude.md",
        filesWritten: [outputPath],
        definitionsIncluded: rulesIncluded,
        definitionsSkipped: rulesSkipped,
        skipReasons,
        content: options.dryRun ? content : undefined,
        contentsByPath: options.dryRun ? contentsByPath : undefined,
        sizeChars: sizeEvaluation.sizeChars,
        sizeBudget: sizeEvaluation.budget,
        sizeBudgetStatus: sizeEvaluation.status,
        topContributors: sizeEvaluation.topContributors,
        ruleContentChars: sizeEvaluation.ruleContentChars,
        perRuleViolations: sizeEvaluation.perRuleViolations,
      };
    },
  };
}

export const claudeMdTarget = makeClaudeMdTarget();

/** Export factory for test injection */
export { makeClaudeMdTarget };

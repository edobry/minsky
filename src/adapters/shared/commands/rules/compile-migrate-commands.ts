/**
 * Rules compile and migrate commands
 */
import { getErrorMessage } from "@minsky/domain/errors/index";
import {
  CommandCategory,
  type CommandDefinition,
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../command-registry";
import { log } from "@minsky/shared/logger";
import { resolveWorkspacePath } from "@minsky/domain/workspace";
import { compileRules, migrateRules } from "@minsky/domain/rules/rules-command-operations";
import type { CompileRulesResult } from "@minsky/domain/rules/rules-command-operations";
import { rulesCompileCommandParams, rulesMigrateCommandParams } from "./rules-parameters";
import type { MemoryLoadingMode } from "@minsky/domain/configuration/schemas/memory";
import { formatTopContributors } from "@minsky/domain/rules/compile/size-budget";

/**
 * Log per-target compile diagnostics (size report, staleness, and mt#2802
 * size-budget status) for a single target's `CompileRulesResult`. Extracted
 * from the original single-target inline logic so the bare-invocation
 * multi-target loop (mt#2803) can call it once per probed target. Returns a
 * short failure descriptor when --check mode failed for this target (stale
 * or size-budget exceeded) so callers can aggregate failures across ALL
 * probed targets instead of throwing on the first one found. Returns
 * undefined when the target passed (or when not in --check mode).
 */
function reportSingleTargetCompile(target: string, result: CompileRulesResult): string | undefined {
  // Report output size on every compile (mt#2802 success criterion #1).
  if (result.sizeChars !== undefined) {
    log.cli(`[rules compile] Target "${target}" output size: ${result.sizeChars} chars`);
  }

  // --check mode: report + fail when output is stale so CI/hooks can detect it.
  if (result.check && result.stale) {
    const staleFile = result.staleFile || "(unknown file)";
    log.cli(`[rules compile --check] Target "${target}" is STALE`);
    log.cli(`  Stale file: ${staleFile}`);
    log.cli(`  Run "minsky rules compile --target ${target}" to regenerate.`);
    return `target "${target}" is stale (${staleFile})`;
  }

  // --check mode: report + fail when output exceeds its fail threshold (mt#2802).
  // Only reachable when NOT stale — a stale target is fixed by regenerating first,
  // at which point the next --check run evaluates the budget against fresh content.
  if (result.check && result.sizeBudgetStatus === "fail" && result.sizeBudget) {
    log.cli(`[rules compile --check] Target "${target}" EXCEEDS SIZE BUDGET`);
    log.cli(
      `  Size: ${result.sizeChars} chars (fail threshold: ${result.sizeBudget.failChars} chars)`
    );
    log.cli(`  Top contributing rules:`);
    for (const line of formatTopContributors(result.topContributors ?? [])) {
      log.cli(`    ${line}`);
    }
    if (result.ruleContentChars !== undefined) {
      log.cli(
        `  (rule content: ${result.ruleContentChars} of ${result.sizeChars} chars; ` +
          `remainder is target scaffolding — banner/headers)`
      );
    }
    log.cli(
      `  Trim the rules above, or override via target options / MINSKY_SKIP_SIZE_BUDGET=1 (pre-commit only).`
    );
    return (
      `target "${target}" exceeds size budget ` +
      `(${result.sizeChars} > ${result.sizeBudget.failChars} chars)`
    );
  }

  // Non-check compiles never fail on budget — warn loudly instead (mt#2802 criterion #6),
  // for either threshold crossed (warn or fail) since only --check hard-fails.
  if (
    !result.check &&
    (result.sizeBudgetStatus === "warn" || result.sizeBudgetStatus === "fail") &&
    result.sizeBudget
  ) {
    const thresholdChars =
      result.sizeBudgetStatus === "fail"
        ? result.sizeBudget.failChars
        : result.sizeBudget.warnChars;
    log.cli(
      `[rules compile] WARNING: target "${target}" output (${result.sizeChars} chars) ` +
        `exceeds its ${result.sizeBudgetStatus} threshold (${thresholdChars} chars).`
    );
    log.cli(`  Top contributing rules:`);
    for (const line of formatTopContributors(result.topContributors ?? [])) {
      log.cli(`    ${line}`);
    }
    if (result.ruleContentChars !== undefined) {
      log.cli(
        `  (rule content: ${result.ruleContentChars} of ${result.sizeChars} chars; ` +
          `remainder is target scaffolding — banner/headers)`
      );
    }
  }

  return undefined;
}

export function registerCompileMigrateCommands(targetRegistry: {
  registerCommand: <T extends CommandParameterMap>(cmd: CommandDefinition<T>) => void;
}): void {
  targetRegistry.registerCommand({
    id: "rules.compile",
    category: CommandCategory.RULES,
    name: "compile",
    description: "Compile rules into a monolithic file (e.g., AGENTS.md or CLAUDE.md)",
    parameters: rulesCompileCommandParams,
    execute: async (params, _ctx?: CommandExecutionContext) => {
      log.debug("Executing rules.compile command", { params });
      try {
        const workspacePath = await resolveWorkspacePath({});

        // Read memory.loadingMode from config; fall back gracefully if config unavailable
        let memoryLoadingMode: MemoryLoadingMode | undefined;
        try {
          const { getConfigurationProvider } = await import("@minsky/domain/configuration/index");
          const config = getConfigurationProvider().getConfig();
          memoryLoadingMode = config.memory?.loadingMode;
        } catch {
          // Config not yet initialized or unavailable — use target default (on_demand)
        }

        // mt#2802: build the override with ONLY the fields actually supplied —
        // never `{ warnChars: undefined, failChars: undefined }` (reviewer R1);
        // an absent field falls back to the target default in resolveSizeBudget.
        const sizeBudgetOverride: { warnChars?: number; failChars?: number } = {};
        if (params.warnChars !== undefined) sizeBudgetOverride.warnChars = params.warnChars;
        if (params.failChars !== undefined) sizeBudgetOverride.failChars = params.failChars;
        const sizeBudget =
          Object.keys(sizeBudgetOverride).length > 0 ? sizeBudgetOverride : undefined;

        const result = await compileRules({
          workspacePath,
          target: params.target,
          output: params.output,
          dryRun: params.dryRun,
          check: params.check,
          memoryLoadingMode,
          sizeBudget,
        });

        // mt#2803: bare invocation compiled multiple targets — report each
        // one via reportSingleTargetCompile so a partial regen is visible,
        // then aggregate --check / size-budget failures across ALL probed
        // targets rather than stopping at the first.
        if (result.targets && result.targets.length > 0) {
          const failures: string[] = [];
          for (const targetResult of result.targets) {
            const failure = reportSingleTargetCompile(targetResult.target, targetResult);
            if (failure) failures.push(failure);
          }
          if (failures.length > 0) {
            throw new Error(
              `rules compile --check: ${failures.length} target(s) failed: ${failures.join("; ")}`
            );
          }
          return result;
        }

        // Single-target path (explicit --target, or a bare invocation that
        // probed to exactly one applicable target) — unchanged behavior.
        const target = result.target || params.target || "agents.md";
        const failure = reportSingleTargetCompile(target, result);
        if (failure) {
          throw new Error(`rules compile --check: ${failure}`);
        }

        return result;
      } catch (error) {
        log.error("Failed to compile rules", {
          error: getErrorMessage(error),
          target: params.target || "agents.md",
        });
        throw error;
      }
    },
  });

  targetRegistry.registerCommand({
    id: "rules.migrate",
    category: CommandCategory.RULES,
    name: "migrate",
    description: "Migrate rules from .cursor/rules/ to .minsky/rules/",
    parameters: rulesMigrateCommandParams,
    execute: async (params) => {
      log.debug("Executing rules.migrate command", { params });
      try {
        const workspacePath = await resolveWorkspacePath({});
        return await migrateRules({
          workspacePath,
          dryRun: params.dryRun || false,
          force: params.force || false,
        });
      } catch (error) {
        log.error("Failed to migrate rules", { error: getErrorMessage(error) });
        throw error;
      }
    },
  });
}

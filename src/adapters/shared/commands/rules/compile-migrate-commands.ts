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
import { rulesCompileCommandParams, rulesMigrateCommandParams } from "./rules-parameters";
import type { MemoryLoadingMode } from "@minsky/domain/configuration/schemas/memory";
import { formatTopContributors } from "@minsky/domain/rules/compile/size-budget";

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

        // mt#2802: only pass a sizeBudget override when at least one field was
        // supplied — an empty {} would still "win" over the target's default
        // via resolveSizeBudget's `??` merge only for the unset field, so this
        // guard just avoids constructing a pointless empty override object.
        const sizeBudget =
          params.warnChars !== undefined || params.failChars !== undefined
            ? { warnChars: params.warnChars, failChars: params.failChars }
            : undefined;

        const result = await compileRules({
          workspacePath,
          target: params.target,
          output: params.output,
          dryRun: params.dryRun,
          check: params.check,
          memoryLoadingMode,
          sizeBudget,
        });

        const target = params.target || "agents.md";

        // Report output size on every compile (mt#2802 success criterion #1).
        if (result.sizeChars !== undefined) {
          log.cli(`[rules compile] Target "${target}" output size: ${result.sizeChars} chars`);
        }

        // --check mode: exit non-zero when output is stale so CI/hooks can detect it.
        if (result.check && result.stale) {
          const staleFile = result.staleFile || "(unknown file)";
          log.cli(`[rules compile --check] Target "${target}" is STALE`);
          log.cli(`  Stale file: ${staleFile}`);
          log.cli(`  Run "minsky rules compile --target ${target}" to regenerate.`);
          throw new Error(`rules compile --check: target "${target}" is stale (${staleFile})`);
        }

        // --check mode: exit non-zero when output exceeds its fail threshold (mt#2802).
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
          log.cli(
            `  Trim the rules above, or override via target options / MINSKY_SKIP_SIZE_BUDGET=1 (pre-commit only).`
          );
          throw new Error(
            `rules compile --check: target "${target}" exceeds size budget ` +
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

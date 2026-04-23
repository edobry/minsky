/**
 * Rules compile and migrate commands
 */
import { getErrorMessage } from "../../../../errors/index";
import {
  CommandCategory,
  type CommandDefinition,
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../command-registry";
import { log } from "../../../../utils/logger";
import { resolveWorkspacePath } from "../../../../domain/workspace";
import { compileRules, migrateRules } from "../../../../domain/rules/rules-command-operations";
import { rulesCompileCommandParams, rulesMigrateCommandParams } from "./rules-parameters";
import type { MemoryLoadingMode } from "../../../../domain/configuration/schemas/memory";

export function registerCompileMigrateCommands(targetRegistry: {
  registerCommand: <T extends CommandParameterMap>(cmd: CommandDefinition<T>) => void;
}): void {
  targetRegistry.registerCommand({
    id: "rules.compile",
    category: CommandCategory.RULES,
    name: "compile",
    description: "Compile rules into a monolithic file (e.g., AGENTS.md or CLAUDE.md)",
    parameters: rulesCompileCommandParams,
    execute: async (
      params: { target?: string; output?: string; dryRun?: boolean; check?: boolean },
      _ctx?: CommandExecutionContext
    ) => {
      log.debug("Executing rules.compile command", { params });
      try {
        const workspacePath = await resolveWorkspacePath({});

        // Read memory.loadingMode from config; fall back gracefully if config unavailable
        let memoryLoadingMode: MemoryLoadingMode | undefined;
        try {
          const { getConfigurationProvider } = await import(
            "../../../../domain/configuration/index"
          );
          const config = getConfigurationProvider().getConfig();
          memoryLoadingMode = config.memory?.loadingMode;
        } catch {
          // Config not yet initialized or unavailable — use target default (on_demand)
        }

        const result = await compileRules({
          workspacePath,
          target: params.target,
          output: params.output,
          dryRun: params.dryRun,
          check: params.check,
          memoryLoadingMode,
        });

        // --check mode: exit non-zero when output is stale so CI/hooks can detect it.
        if (result.check && result.stale) {
          const target = params.target || "agents.md";
          const staleFile = result.staleFile || "(unknown file)";
          log.cli(`[rules compile --check] Target "${target}" is STALE`);
          log.cli(`  Stale file: ${staleFile}`);
          log.cli(`  Run "minsky rules compile --target ${target}" to regenerate.`);
          throw new Error(`rules compile --check: target "${target}" is stale (${staleFile})`);
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
    execute: async (params: { dryRun?: boolean; force?: boolean }) => {
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

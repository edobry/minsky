/**
 * Minsky compile commands — CLI/MCP adapter.
 *
 * Registers the `compile` command that transforms TypeScript definition
 * modules into harness-specific output files (e.g., SKILL.md for Claude).
 */

import { z } from "zod";
import { getErrorMessage } from "../../../../errors/index";
import {
  CommandCategory,
  type CommandDefinition,
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../command-registry";
import { log } from "../../../../utils/logger";
import { runMinskyCompile } from "../../../../domain/compile/compile";

const compileCommandParams = {
  target: {
    schema: z.string(),
    description: 'Compile target to run (e.g. "claude-skills"). Defaults to "claude-skills".',
    required: false,
    defaultValue: "claude-skills",
  },
  output: {
    schema: z.string().optional(),
    description: "Override the default output directory for the target.",
    required: false,
  },
  dryRun: {
    schema: z.boolean(),
    description: "Print compiled content without writing files.",
    required: false,
    defaultValue: false,
  },
  check: {
    schema: z.boolean(),
    description: "Check whether output files are up-to-date. Exits non-zero when stale.",
    required: false,
    defaultValue: false,
  },
} satisfies CommandParameterMap;

export function registerCompileCommands(targetRegistry: {
  registerCommand: <T extends CommandParameterMap>(cmd: CommandDefinition<T>) => void;
}): void {
  targetRegistry.registerCommand({
    id: "compile",
    category: CommandCategory.COMPILE,
    name: "compile",
    description: "Compile TypeScript definition modules into harness-specific output files.",
    parameters: compileCommandParams,
    execute: async (
      params: { target?: string; output?: string; dryRun?: boolean; check?: boolean },
      _ctx?: CommandExecutionContext
    ) => {
      log.debug("Executing compile command", { params });
      try {
        const result = await runMinskyCompile({
          target: params.target,
          output: params.output,
          dryRun: params.dryRun,
          check: params.check,
        });

        // --check mode: throw when stale so CI/hooks detect it.
        if (result.check && result.stale) {
          const target = params.target ?? "claude-skills";
          const staleFile = result.staleFile ?? "(unknown file)";
          log.cli(`[compile --check] Target "${target}" is STALE`);
          log.cli(`  Stale file: ${staleFile}`);
          log.cli(`  Run "minsky compile --target ${target}" to regenerate.`);
          throw new Error(`compile --check: target "${target}" is stale (${staleFile})`);
        }

        return result;
      } catch (error) {
        log.error("Failed to compile", {
          error: getErrorMessage(error),
          target: params.target ?? "claude-skills",
        });
        throw error;
      }
    },
  });
}

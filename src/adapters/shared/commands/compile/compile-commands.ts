/**
 * Minsky compile commands — CLI/MCP adapter.
 *
 * Registers the `compile` command that transforms TypeScript definition
 * modules into harness-specific output files (e.g., SKILL.md for Claude).
 */

import { z } from "zod";
import { getErrorMessage } from "@minsky/domain/errors/index";
import {
  CommandCategory,
  type CommandDefinition,
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../command-registry";
import { log } from "@minsky/shared/logger";
import { runMinskyCompile } from "@minsky/domain/compile/compile";

const compileCommandParams = {
  target: {
    schema: z.string().optional(),
    description:
      'Compile target to run (e.g. "claude-skills"). When omitted (bare invocation), ' +
      "compiles every target whose .minsky/ source dir exists — a partial regen is " +
      'never silently reported as success (mt#2803). Falls back to "claude-skills" ' +
      "when no source dir exists yet (fresh repo).",
    required: false,
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
    execute: async (params, _ctx?: CommandExecutionContext) => {
      log.debug("Executing compile command", { params });
      try {
        const result = await runMinskyCompile({
          target: params.target,
          output: params.output,
          dryRun: params.dryRun,
          check: params.check,
        });

        // mt#2803: bare invocation compiled multiple targets — render one
        // line per target so a partial regen is visible, and aggregate
        // --check failures across ALL probed targets rather than stopping
        // at the first.
        if (result.targets && result.targets.length > 0) {
          const staleTargets: string[] = [];
          for (const targetResult of result.targets) {
            log.cli(
              `[compile] Target "${targetResult.target}": ` +
                `${targetResult.filesWritten.length} file(s) written`
            );
            if (result.check && targetResult.stale) {
              const staleFile = targetResult.staleFile ?? "(unknown file)";
              log.cli(`[compile --check] Target "${targetResult.target}" is STALE`);
              log.cli(`  Stale file: ${staleFile}`);
              log.cli(`  Run "minsky compile --target ${targetResult.target}" to regenerate.`);
              staleTargets.push(targetResult.target);
            }
          }
          if (staleTargets.length > 0) {
            throw new Error(
              `compile --check: ${staleTargets.length} target(s) stale: ${staleTargets.join(", ")}`
            );
          }
          return result;
        }

        // Single-target path (explicit --target, or a bare invocation that
        // probed to exactly one applicable target) — unchanged behavior.
        if (result.check && result.stale) {
          const target = params.target ?? result.target ?? "claude-skills";
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

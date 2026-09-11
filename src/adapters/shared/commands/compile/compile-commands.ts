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
import { runMinskyCompile as realRunMinskyCompile } from "@minsky/domain/compile/compile";
import type { MinskyCompileServiceResult } from "@minsky/domain/compile/compile-service";
import {
  hasSizeBudgetFields,
  reportMonolithicSizeBudget,
} from "@minsky/domain/compile/size-budget-report";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import { resolveMemoryLoadingMode, buildSizeBudgetOverride } from "./cli-options";
import { buildSessionDirResolver, resolveValidateWorkspace } from "../validate";

// Session routing (mt#4394), on the same contract as `validate_typecheck` /
// `validate_lint`: `workspace` wins, else `task` / `sessionId` resolve to that
// session's workdir, else cwd — so an existing caller that passes none of them
// sees no change. `workspace` deliberately has NO default value, for the reason
// `validate.ts` states at its own `workspaceParam`: a cwd default would populate
// the field on every call and the session leg would never run (mt#2336).
//
// Until this landed `compile` was the one validate-class tool with no routing,
// so a session editing `.minsky/rules/**`, `.minsky/skills/**` or
// `.minsky/hooks/**` had to shell out to `bun run src/cli.ts compile` — the
// shape the `cli-mcp-substitution` detector exists to discourage, and 61% of
// that detector's fires in its first-ever calibration review.
const compileRoutingParams = {
  workspace: {
    schema: z.string(),
    description:
      "Workspace directory to compile. When omitted (and no task/sessionId), defaults to the " +
      "current working directory — the MAIN workspace when invoked over MCP.",
    required: false,
  },
  task: {
    schema: z.string(),
    description: "Task ID whose session workspace should be compiled (e.g. 'mt#123')",
    required: false,
  },
  sessionId: {
    schema: z.string(),
    description: "Session ID whose workspace should be compiled",
    required: false,
  },
} satisfies CommandParameterMap;

const compileCommandParams = {
  ...compileRoutingParams,
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
  warnChars: {
    schema: z.number().int().positive().optional(),
    description:
      "Override the target's default WARN size-budget threshold (chars). mt#2992 — only " +
      "claude.md and agents.md enforce a size budget; other targets ignore this.",
    required: false,
  },
  failChars: {
    schema: z.number().int().positive().optional(),
    description:
      "Override the target's default FAIL size-budget threshold (chars, --check mode hard-fails " +
      "on it). mt#2992 — only claude.md and agents.md enforce a size budget; other targets ignore this.",
    required: false,
  },
  overwrite: {
    schema: z.boolean(),
    description:
      "Replace output files that exist without a generation banner — i.e. files that are yours, " +
      "not Minsky's. Without it such a file is left alone and named in the output (mt#5065).",
    required: false,
    defaultValue: false,
  },
} satisfies CommandParameterMap;

/**
 * The command's collaborators, injectable so the routing can be tested through
 * the REAL `runMinskyCompile` over a fake filesystem (ADR-026: real defaults
 * here, the test hands in what it needs, no spy on a module import).
 */
export interface CompileCommandDeps {
  runMinskyCompile: typeof realRunMinskyCompile;
  /** The fallback directory when no routing field is given. */
  cwd: () => string;
}

/** The result the command returns: the domain result plus where it compiled. */
export type CompileCommandResult = MinskyCompileServiceResult & {
  /**
   * The directory actually compiled (mt#4394). Named after the siblings'
   * `validatedWorkspace` — the verb is what the command did — so a caller can
   * confirm the tree that was regenerated rather than infer it.
   */
  compiledWorkspace: string;
};

export function registerCompileCommands(
  targetRegistry: {
    registerCommand: <T extends CommandParameterMap>(cmd: CommandDefinition<T>) => void;
  },
  container?: AppContainerInterface,
  deps: CompileCommandDeps = { runMinskyCompile: realRunMinskyCompile, cwd: () => process.cwd() }
): void {
  const resolveSessionDir = buildSessionDirResolver(container);
  targetRegistry.registerCommand({
    id: "compile",
    category: CommandCategory.COMPILE,
    name: "compile",
    description: "Compile TypeScript definition modules into harness-specific output files.",
    parameters: compileCommandParams,
    execute: async (params, _ctx?: CommandExecutionContext): Promise<CompileCommandResult> => {
      log.debug("Executing compile command", { params });
      try {
        // Resolved BEFORE anything else so a routing failure (an unknown task,
        // no container) surfaces as such rather than as a compile of main —
        // `buildSessionDirResolver` throws instead of falling back for exactly
        // that reason.
        const compiledWorkspace = await resolveValidateWorkspace(
          { workspace: params.workspace, task: params.task, sessionId: params.sessionId },
          resolveSessionDir,
          deps.cwd()
        );
        // mt#2992 review R1 (non-blocking 1): both compile entry points share
        // this config-read + override-construction logic via cli-options.ts
        // so they can't drift. params.warnChars/params.failChars are already
        // validated numbers here (the zod schema above is enforced at the
        // parameter-parsing boundary — schema-bridge.ts's
        // parseOptionsToParameters / the MCP tool-call validator) — no
        // additional parsing needed on this surface, unlike the raw-Commander
        // direct-CLI entry point (src/commands/compile/index.ts).
        const memoryLoadingMode = await resolveMemoryLoadingMode();
        const sizeBudget = buildSizeBudgetOverride(params.warnChars, params.failChars);

        const compiled = await deps.runMinskyCompile({
          target: params.target,
          output: params.output,
          dryRun: params.dryRun,
          check: params.check,
          sizeBudget,
          memoryLoadingMode,
          overwrite: params.overwrite,
          workspacePath: compiledWorkspace,
        });
        const result: CompileCommandResult = { ...compiled, compiledWorkspace };

        // mt#2803: bare invocation compiled multiple targets — render one
        // line per target so a partial regen is visible, and aggregate
        // --check failures across ALL probed targets rather than stopping
        // at the first. mt#2992 adds size-budget reporting per target,
        // using the SAME "fix staleness first" precedence
        // classifyCompileCheckError encodes: a stale target's budget is not
        // evaluated (its dry-run content may not reflect what a regenerate
        // would produce).
        // mt#4986 SC2: a monolithic output left alone because it is the user's
        // own file. Rendered at the TOP level, before the per-target lines,
        // because the target it concerns may never have run — a foreign file is
        // gated out of the probe, so there is no per-target line to hang this
        // off. Same reasoning as `skipReasons` for the sink: `log.warn` is
        // discarded by a one-shot command, so the reason has to come back on
        // the result and be printed here or the operator sees nothing.
        for (const skipped of result.skippedForeignOutputs ?? []) {
          log.cli(`[compile] ${skipped.reason}`);
        }
        // mt#5065: a replacement the operator asked for with --overwrite is
        // still a destruction of someone's file, so it is named, not silent.
        for (const replaced of result.foreignOverwritten ?? []) {
          log.cli(
            `[compile] Overwrote ${replaced} — it carried no generation banner (--overwrite).`
          );
        }

        // mt#573 SC5, the run-level selection report. Top-level for the same
        // reason as the block above: it belongs to the run, not to any one
        // target, and on a single-target invocation `result.targets` is
        // undefined so the per-target loop below never executes.
        for (const reason of result.skipReasons ?? []) {
          log.cli(`[compile] ${reason}`);
        }

        if (result.targets && result.targets.length > 0) {
          const staleTargets: string[] = [];
          const budgetFailures: string[] = [];
          for (const targetResult of result.targets) {
            log.cli(
              `[compile] Target "${targetResult.target}": ` +
                `${targetResult.filesWritten.length} file(s) written`
            );
            // mt#3119: surface FAILURE skips beside the file count — `onSkip` routes to
            // `log.warn`, which a one-shot command discards. `skipReasons` only, not
            // `definitionsSkipped` (benign "not selected" for the rule targets).
            for (const reason of targetResult.skipReasons ?? []) {
              log.cli(`[compile] ${reason}`);
            }
            if (result.check && targetResult.stale) {
              const staleFile = targetResult.staleFile ?? "(unknown file)";
              log.cli(`[compile --check] Target "${targetResult.target}" is STALE`);
              log.cli(`  Stale file: ${staleFile}`);
              log.cli(`  Run "minsky compile --target ${targetResult.target}" to regenerate.`);
              staleTargets.push(targetResult.target);
              continue;
            }
            if (hasSizeBudgetFields(targetResult)) {
              const failure = reportMonolithicSizeBudget(
                targetResult.target,
                targetResult,
                log.cli
              );
              if (failure) budgetFailures.push(failure);
            }
          }
          if (staleTargets.length > 0) {
            throw new Error(
              `compile --check: ${staleTargets.length} target(s) stale: ${staleTargets.join(", ")}`
            );
          }
          if (budgetFailures.length > 0) {
            throw new Error(
              `compile --check: ${budgetFailures.length} target(s) failed: ${budgetFailures.join("; ")}`
            );
          }
          return result;
        }

        // Single-target path (explicit --target, or a bare invocation that
        // probed to exactly one applicable target).
        if (result.check && result.stale) {
          const target = params.target ?? result.target ?? "claude-skills";
          const staleFile = result.staleFile ?? "(unknown file)";
          log.cli(`[compile --check] Target "${target}" is STALE`);
          log.cli(`  Stale file: ${staleFile}`);
          log.cli(`  Run "minsky compile --target ${target}" to regenerate.`);
          throw new Error(`compile --check: target "${target}" is stale (${staleFile})`);
        }

        if (hasSizeBudgetFields(result)) {
          const target = params.target ?? result.target ?? "claude-skills";
          const failure = reportMonolithicSizeBudget(target, result, log.cli);
          if (failure) {
            throw new Error(`compile --check: ${failure}`);
          }
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

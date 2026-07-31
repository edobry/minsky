/**
 * Compile command — direct Commander.js registration.
 *
 * Exposes `minsky compile [options]` as a top-level command.
 * Delegates to the domain operation via runMinskyCompile.
 *
 * **mt#2992 note on duplicate registration.** `compile` is ALSO registered in
 * the shared command registry (`src/adapters/shared/commands/compile/
 * compile-commands.ts`), which serves the MCP tool surface; that
 * registration is hidden from CLI auto-generation (see
 * `src/adapters/cli/customizations/compile-customizations.ts`) specifically
 * so this direct Commander.js command is the one that actually runs for
 * `bun run src/cli.ts compile ...`. The two implementations are independent
 * — this file was NOT in mt#2992's originally scoped file list, but is a
 * necessary consumer for that task's own CLI-level acceptance criteria
 * (`compile --target claude.md --check` hard-failing on a size-budget/
 * per-rule-ceiling violation only works if THIS file emits the check). The
 * `warnChars`/`failChars` params were added to `compile-commands.ts`'s param
 * map per the spec; this file's `--warn-chars`/`--fail-chars` options thread
 * into the SAME `runMinskyCompile()` domain call, and both files share the
 * SAME `reportMonolithicSizeBudget()` reporter (`packages/domain/src/
 * compile/size-budget-report.ts`) plus the SAME `resolveMemoryLoadingMode()`
 * / `buildSizeBudgetOverride()` helpers (`../../adapters/shared/commands/
 * compile/cli-options.ts`) so neither the marker strings
 * `classifyCompileCheckError` string-matches, nor the config-read /
 * override-construction logic, are duplicated a third time (mt#2992 review
 * R1).
 */

import { Command } from "commander";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "@minsky/domain/errors/index";
import { runMinskyCompile } from "@minsky/domain/compile/compile";
import {
  hasSizeBudgetFields,
  reportMonolithicSizeBudget,
} from "@minsky/domain/compile/size-budget-report";
import {
  resolveMemoryLoadingMode,
  buildSizeBudgetOverride,
  parseCliSizeBudgetChars,
} from "../../adapters/shared/commands/compile/cli-options";

export function createCompileCommand(): Command {
  const compile = new Command("compile")
    .description("Compile TypeScript definition modules into harness-specific output files.")
    .option(
      "--target <target>",
      'Compile target to run (e.g. "claude-skills"). When omitted (bare invocation), ' +
        "compiles every target whose .minsky/ source dir exists (mt#2803) — a partial " +
        'regen is never silently reported as success. Falls back to "claude-skills" ' +
        "when no source dir exists yet (fresh repo)."
    )
    .option("--output <path>", "Override the default output directory for the target.")
    .option("--dry-run", "Print compiled content without writing files.", false)
    .option(
      "--check",
      "Check whether output files are up-to-date. Exits non-zero when stale.",
      false
    )
    .option(
      "--warn-chars <n>",
      "Override the target's default WARN size-budget threshold (chars). mt#2992 — only " +
        "claude.md and agents.md enforce a size budget; other targets ignore this."
    )
    .option(
      "--fail-chars <n>",
      "Override the target's default FAIL size-budget threshold (chars, --check mode hard-fails " +
        "on it). mt#2992 — only claude.md and agents.md enforce a size budget; other targets ignore this."
    )
    .action(async (opts) => {
      try {
        // mt#2992 review R1 (BLOCKING) — validate BEFORE any other work so a
        // bad flag fails fast with a clear, flag-named error rather than
        // silently coercing to NaN (see parseCliSizeBudgetChars's doc comment
        // for the exact failure mode this closes: an unvalidated NaN WINS
        // over the real default in resolveSizeBudget's `??` merge, so the
        // size-budget check would silently never fire).
        const warnChars = parseCliSizeBudgetChars("--warn-chars", opts.warnChars);
        const failChars = parseCliSizeBudgetChars("--fail-chars", opts.failChars);
        const sizeBudget = buildSizeBudgetOverride(warnChars, failChars);
        const memoryLoadingMode = await resolveMemoryLoadingMode();

        const result = await runMinskyCompile({
          target: opts.target as string | undefined,
          output: opts.output as string | undefined,
          dryRun: opts.dryRun as boolean,
          check: opts.check as boolean,
          sizeBudget,
          memoryLoadingMode,
        });

        // mt#2803: bare invocation compiled multiple targets — render one
        // line (+ dry-run content, if requested) per target so a partial
        // regen is visible, and aggregate --check failures across ALL
        // probed targets rather than stopping at the first. mt#2992 adds
        // size-budget reporting per target, using the same "fix staleness
        // first" precedence classifyCompileCheckError encodes.
        if (result.targets && result.targets.length > 0) {
          let anyStale = false;
          let anyBudgetFailure = false;
          for (const targetResult of result.targets) {
            log.cli(
              `[compile] Target "${targetResult.target}": ` +
                `${targetResult.filesWritten.length} file(s) written`
            );
            if (opts.dryRun && targetResult.content) {
              log.cli(targetResult.content);
            }
            if (result.check && targetResult.stale) {
              const staleFile = targetResult.staleFile ?? "(unknown file)";
              log.cli(`[compile --check] Target "${targetResult.target}" is STALE`);
              log.cli(`  Stale file: ${staleFile}`);
              log.cli(`  Run "minsky compile --target ${targetResult.target}" to regenerate.`);
              anyStale = true;
              continue;
            }
            if (hasSizeBudgetFields(targetResult)) {
              const failure = reportMonolithicSizeBudget(
                targetResult.target,
                targetResult,
                log.cli
              );
              if (failure) anyBudgetFailure = true;
            }
          }
          if (anyStale || anyBudgetFailure) {
            process.exit(1);
          }
          return;
        }

        // Single-target path (explicit --target, or a bare invocation that
        // probed to exactly one applicable target).
        if (result.check && result.stale) {
          const target = (opts.target as string | undefined) ?? result.target ?? "claude-skills";
          const staleFile = result.staleFile ?? "(unknown file)";
          log.cli(`[compile --check] Target "${target}" is STALE`);
          log.cli(`  Stale file: ${staleFile}`);
          log.cli(`  Run "minsky compile --target ${target}" to regenerate.`);
          process.exit(1);
        }

        if (hasSizeBudgetFields(result)) {
          const target = (opts.target as string | undefined) ?? result.target ?? "claude-skills";
          const failure = reportMonolithicSizeBudget(target, result, log.cli);
          if (failure) {
            process.exit(1);
          }
        }

        if (opts.dryRun && result.content) {
          log.cli(result.content);
        } else {
          // Omit contentsByPath (Map) from JSON output — not JSON-serializable
          const { contentsByPath: _omit, ...displayResult } = result;
          log.cli(JSON.stringify(displayResult, null, 2));
        }
      } catch (error) {
        log.error("Compile failed", { error: getErrorMessage(error) });
        process.exit(1);
      }
    });

  return compile;
}

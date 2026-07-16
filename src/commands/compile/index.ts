/**
 * Compile command — direct Commander.js registration.
 *
 * Exposes `minsky compile [options]` as a top-level command.
 * Delegates to the domain operation via runMinskyCompile.
 */

import { Command } from "commander";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "@minsky/domain/errors/index";
import { runMinskyCompile } from "@minsky/domain/compile/compile";

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
    .action(async (opts) => {
      try {
        const result = await runMinskyCompile({
          target: opts.target as string | undefined,
          output: opts.output as string | undefined,
          dryRun: opts.dryRun as boolean,
          check: opts.check as boolean,
        });

        // mt#2803: bare invocation compiled multiple targets — render one
        // line (+ dry-run content, if requested) per target so a partial
        // regen is visible, and aggregate --check failures across ALL
        // probed targets rather than stopping at the first.
        if (result.targets && result.targets.length > 0) {
          let anyStale = false;
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
            }
          }
          if (anyStale) {
            process.exit(1);
          }
          return;
        }

        // Single-target path (explicit --target, or a bare invocation that
        // probed to exactly one applicable target) — unchanged behavior.
        if (result.check && result.stale) {
          const target = (opts.target as string | undefined) ?? result.target ?? "claude-skills";
          const staleFile = result.staleFile ?? "(unknown file)";
          log.cli(`[compile --check] Target "${target}" is STALE`);
          log.cli(`  Stale file: ${staleFile}`);
          log.cli(`  Run "minsky compile --target ${target}" to regenerate.`);
          process.exit(1);
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

/**
 * Compile command — direct Commander.js registration.
 *
 * Exposes `minsky compile [options]` as a top-level command.
 * Delegates to the domain operation via runMinskyCompile.
 */

import { Command } from "commander";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
import { runMinskyCompile } from "../../domain/compile/compile";

export function createCompileCommand(): Command {
  const compile = new Command("compile")
    .description("Compile TypeScript definition modules into harness-specific output files.")
    .option(
      "--target <target>",
      'Compile target to run (e.g. "claude-skills"). Defaults to "claude-skills".',
      "claude-skills"
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
          target: opts.target as string,
          output: opts.output as string | undefined,
          dryRun: opts.dryRun as boolean,
          check: opts.check as boolean,
        });

        // --check mode: exit non-zero when stale so CI/hooks can detect it.
        if (result.check && result.stale) {
          const target = (opts.target as string) ?? "claude-skills";
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

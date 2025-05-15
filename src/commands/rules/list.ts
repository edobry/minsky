import { Command } from "commander";
import { RuleService } from "../../domain/index.js";
import type { RuleFormat } from "../../domain/rules.js";
import { exit } from "../../utils/process.js";
import { log } from "../../utils/logger.js";

export function createListCommand(): Command {
  return new Command("list")
    .description("List all Minsky rules in a repository")
    .option(
      "--format <format>",
      "Type of rules to list (cursor or generic)",
      /^(cursor|generic|both)$/i,
      "both"
    )
    .option("--tag <tag>", "Filter rules by tag")
    .option("--json", "Output as JSON")
    .option("--repo <path>", "Path to repository (default: current directory)")
    .option("--session <n>", "Use session for repo resolution")
    .action(async (options) => {
      try {
        // Resolve the repo path
        const repoPath = await resolveRepoPath({
          repo: options.repo,
          session: options.session,
        });

        // Initialize the rule service
        const ruleService = new RuleService(repoPath);

        // Get the format option
        let format: RuleFormat | undefined;
        if (options.format && options.format !== "both") {
          format = options.format.toLowerCase() as RuleFormat;
        }

        // List rules with the given options
        const rules = await ruleService.listRules({
          format,
          tag: options.tag,
        });

        if (options.json) {
          // Output as JSON
          log.cli(JSON.stringify(rules, null, 2));
        } else {
          // Output in a human-readable format
          if (rules.length === 0) {
            log.cli("No rules found.");
            return;
          }

          log.cli(`Found ${rules.length} rules:`);
          log.cli("");

          for (const rule of rules) {
            const formatLabel = rule.format === "cursor" ? "Cursor" : "Generic";
            const tags = rule.tags ? ` [${rule.tags.join(", ")}]` : "";

            log.cli(`${rule.id} (${formatLabel})${tags}`);
            if (rule.description) {
              log.cli(`  ${rule.description}`);
            }
            log.cli("");
          }
        }
      } catch (error) {
        log.cliError(
          `Error listing rules: ${error instanceof Error ? error.message : String(error)}`
        );
        exit(1);
      }
    });
}

// Helper function for repo path resolution - get from domain index
async function resolveRepoPath(options: { repo?: string; session?: string }): Promise<string> {
  try {
    const { resolveRepoPath: resolve } = await import("../../domain/index.js");
    return await resolve(options);
  } catch (error) {
    log.cliError(
      `Error resolving repository path: ${error instanceof Error ? error.message : String(error)}`
    );
    exit(1);
    // This line is unreachable but needed for TypeScript return type
    throw new Error("Failed to resolve repository path");
  }
}

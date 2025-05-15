import { Command } from "commander";
import { RuleService } from "../../domain/index.js";
import * as prompts from "@clack/prompts";
import { exit } from "../../utils/process.js";
import { log } from "../../utils/logger.js";

export function createGetCommand(): Command {
  return new Command("get")
    .description("Get a specific Minsky rule by ID")
    .argument("<ruleId>", "ID of the rule to get (without .mdc extension)")
    .option("--json", "Output as JSON")
    .option("--meta-only", "Only show frontmatter metadata")
    .option("--format <format>", "Format of the rule (cursor or generic)")
    .option("--repo <path>", "Path to repository (default: current directory)")
    .option("--session <n>", "Use session for repo resolution")
    .option("--debug", "Display debug information about rule loading")
    .action(async (ruleId, options) => {
      try {
        // Resolve the repo path - reuse the function from domain index
        const { resolveRepoPath } = await import("../../domain/index.js");
        const repoPath = await resolveRepoPath({
          repo: options.repo,
          session: options.session,
        });

        if (options.debug) {
          log.debug("Rules get command debug info", {
            resolvedRepoPath: repoPath,
            ruleId,
            format: options.format
          });
        }

        // Initialize the rule service
        const ruleService = new RuleService(repoPath);

        log.debug("Getting rule", {
          ruleId,
          format: options.format
        });

        // Get the rule
        const rule = await ruleService.getRule(ruleId, {
          format: options.format,
        });

        if (options.json) {
          // If meta-only, output only the metadata
          if (options.metaOnly) {
            const { content, ...meta } = rule;
            log.agent(JSON.stringify(meta, null, 2));
          } else {
            log.agent(JSON.stringify(rule, null, 2));
          }
        } else {
          // Human-readable output
          const formatLabel = rule.format === "cursor" ? "Cursor" : "Generic";
          const tags = rule.tags ? ` [${rule.tags.join(", ")}]` : "";

          log.cli(`Rule: ${rule.id} (${formatLabel})${tags}`);

          if (rule.name) {
            log.cli(`Name: ${rule.name}`);
          }

          if (rule.description) {
            log.cli(`Description: ${rule.description}`);
          }

          log.cli(`Path: ${rule.path}`);

          if (rule.globs && rule.globs.length > 0) {
            log.cli(`Globs: ${rule.globs.join(", ")}`);
          }

          log.cli(`Always Apply: ${rule.alwaysApply ? "Yes" : "No"}`);

          // Display format conversion notice if present
          if (rule.formatNote) {
            log.cliWarn(`Format Notice: ${rule.formatNote}`);
          }

          // If we don't want to see the content, stop here
          if (options.metaOnly) {
            return;
          }

          log.cli("\nContent:");
          log.cli("---------------------------");
          log.cli(rule.content);
          log.cli("---------------------------");
        }
      } catch (error) {
        log.error("Error getting rule", {
          ruleId,
          format: options.format,
          repo: options.repo,
          session: options.session,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        
        if (options.json) {
          log.agent(JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error)
          }));
        } else {
          log.cliError(`Error getting rule: ${error instanceof Error ? error.message : String(error)}`);
        }
        
        exit(1);
      }
    });
}

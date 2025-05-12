import { Command } from "commander";
import { RuleService } from "../../domain/index.js";
import type { RuleMeta } from "../../domain/rules.js";
import { promises as fs } from "fs";
import { exit } from "../../utils/process.js";

export function createUpdateCommand(): Command {
  return new Command("update")
    .description("Update an existing Minsky rule")
    .argument("<ruleId>", "ID of the rule to update (without .mdc extension)")
    .option("--name <name>", "New name for the rule")
    .option("--description <description>", "New description of what the rule does")
    .option("--globs <globs...>", "New file patterns this rule applies to")
    .option("--always-apply <boolean>", "Whether rule should always be applied", (value) => value === "true")
    .option("--tags <tags...>", "New tags for categorization")
    .option("--content <file>", "File containing new rule content (or - for stdin)")
    .option("--format <format>", "Rule format to update (cursor or generic)")
    .option("--meta-only", "Only update metadata, not content")
    .option("--repo <path>", "Path to repository (default: current directory)")
    .option("--session <n>", "Use session for repo resolution")
    .action(async (ruleId, options) => {
      try {
        // Resolve the repo path - reuse the function from domain index
        const { resolveRepoPath } = await import("../../domain/index.js");
        const repoPath = await resolveRepoPath({
          repo: options.repo,
          session: options.session
        });
        
        // Initialize the rule service
        const ruleService = new RuleService(repoPath);
        
        // Prepare update options
        const updateOptions: {
          content?: string;
          meta?: Partial<RuleMeta>;
        } = {};
        
        // Handle metadata updates if any
        if (options.name || options.description || options.globs || 
            options.alwaysApply !== undefined || options.tags) {
          updateOptions.meta = {};
          
          if (options.name) updateOptions.meta.name = options.name;
          if (options.description) updateOptions.meta.description = options.description;
          if (options.globs) updateOptions.meta.globs = options.globs;
          if (options.alwaysApply !== undefined) updateOptions.meta.alwaysApply = options.alwaysApply;
          if (options.tags) updateOptions.meta.tags = options.tags;
        }
        
        // Handle content update if provided and not in meta-only mode
        if (options.content && !options.metaOnly) {
          if (options.content === "-") {
            // Read from stdin
            const { readFromStdin } = await import("./stdin-helpers.js");
            updateOptions.content = await readFromStdin();
          } else {
            // Read from file
            updateOptions.content = await fs.readFile(options.content, "utf-8");
          }
        }
        
        // Ensure we have something to update
        if (!updateOptions.meta && !updateOptions.content) {
          console.error(
            "Error: No updates specified. Use --name, --description, --globs, --always-apply, --tags, or --content."
          );
          exit(1);
        }
        
        // Update the rule
        const rule = await ruleService.updateRule(
          ruleId, 
          updateOptions, 
          { format: options.format }
        );
        
        console.log(`Rule '${rule.id}' updated successfully.`);
        
        // Show what was updated
        if (updateOptions.meta) {
          console.log("Updated metadata:");
          Object.entries(updateOptions.meta).forEach(([key, value]) => {
            console.log(`  ${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
          });
        }
        
        if (updateOptions.content) {
          console.log("Content was updated.");
        }
        
      } catch (error) {
        console.error(
          `Error updating rule: ${error instanceof Error ? error.message : String(error)}`
        );
        exit(1);
      }
    });
}

// Helper function to read from stdin
async function readFromStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data);
    });
  });
} 

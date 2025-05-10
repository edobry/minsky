import { Command } from "commander";
import { RuleService } from "../../domain/index.js";

export function createGetCommand(): Command {
  return new Command("get")
    .description("Get a specific Minsky rule by ID")
    .argument("<ruleId>", "ID of the rule to get (without .mdc extension)")
    .option("--json", "Output as JSON")
    .option("--meta-only", "Only show frontmatter metadata")
    .option("--format <format>", "Format of the rule (cursor or generic)")
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
        
        // Get the rule
        const rule = await ruleService.getRule(ruleId, { 
          format: options.format 
        });
        
        if (options.json) {
          // If meta-only, output only the metadata
          if (options.metaOnly) {
            const { content, ...meta } = rule;
            console.log(JSON.stringify(meta, null, 2));
          } else {
            console.log(JSON.stringify(rule, null, 2));
          }
        } else {
          // Human-readable output
          const formatLabel = rule.format === "cursor" ? "Cursor" : "Generic";
          const tags = rule.tags ? ` [${rule.tags.join(", ")}]` : "";
          
          console.log(`Rule: ${rule.id} (${formatLabel})${tags}`);
          
          if (rule.name) {
            console.log(`Name: ${rule.name}`);
          }
          
          if (rule.description) {
            console.log(`Description: ${rule.description}`);
          }
          
          console.log(`Path: ${rule.path}`);
          
          if (rule.globs && rule.globs.length > 0) {
            console.log(`Globs: ${rule.globs.join(", ")}`);
          }
          
          console.log(`Always Apply: ${rule.alwaysApply ? "Yes" : "No"}`);
          
          // If we don't want to see the content, stop here
          if (options.metaOnly) {
            return;
          }
          
          console.log("\nContent:");
          console.log("---------------------------");
          console.log(rule.content);
          console.log("---------------------------");
        }
      } catch (error) {
        console.error(`Error getting rule: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
} 

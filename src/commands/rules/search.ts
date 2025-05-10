import { Command } from "commander";
import { RuleService } from "../../domain/index.js";
import { exit } from "../../utils/process.js";

export function createSearchCommand(): Command {
  return new Command("search")
    .description("Search for Minsky rules by content or metadata")
    .argument("<query>", "Search query")
    .option("--format <format>", "Type of rules to search (cursor or generic)")
    .option("--tag <tag>", "Filter by tag")
    .option("--json", "Output as JSON")
    .option("--repo <path>", "Path to repository (default: current directory)")
    .option("--session <n>", "Use session for repo resolution")
    .action(async (query, options) => {
      try {
        // Resolve the repo path
        const { resolveRepoPath } = await import("../../domain/index.js");
        const repoPath = await resolveRepoPath({
          repo: options.repo,
          session: options.session
        });
        
        // Initialize the rule service
        const ruleService = new RuleService(repoPath);
        
        // Search for rules
        const rules = await ruleService.searchRules({
          query,
          format: options.format,
          tag: options.tag
        });
        
        if (options.json) {
          // Output as JSON
          console.log(JSON.stringify(rules, null, 2));
        } else {
          // Output in a human-readable format
          if (rules.length === 0) {
            console.log(`No rules found matching query: "${query}"`);
            return;
          }
          
          console.log(`Found ${rules.length} rules matching query: "${query}"`);
          console.log();
          
          for (const rule of rules) {
            const formatLabel = rule.format === "cursor" ? "Cursor" : "Generic";
            const tags = rule.tags ? ` [${rule.tags.join(", ")}]` : "";
            
            console.log(`${rule.id} (${formatLabel})${tags}`);
            if (rule.description) {
              console.log(`  ${rule.description}`);
            }
            console.log();
          }
        }
      } catch (error) {
        console.error(
          `Error searching rules: ${error instanceof Error ? error.message : String(error)}`
        );
        exit(1);
      }
    });
} 

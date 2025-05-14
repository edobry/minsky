import { Command } from "commander";
import { RuleService } from "../../domain/index.js";
import * as prompts from "@clack/prompts";
import { promises as fs } from "fs";
import { join, dirname } from "path";
import { existsSync } from "fs";
import { execSync } from "child_process";
import { exit } from "../../utils/process.js";

/**
 * Creates a command to sync rules between the main workspace and session workspaces
 */
export function createSyncCommand(): Command {
  return new Command("sync")
    .description("Synchronize rules between main workspace and session workspaces")
    .option("--from <path>", "Source workspace path (defaults to main workspace)")
    .option("--to <path>", "Destination workspace path (defaults to current session)")
    .option("--rule <rule-id>", "Sync only a specific rule (default: all rules)")
    .option("--direction <direction>", "Sync direction: 'to-session', 'from-session', or 'both' (default: to-session)")
    .option("--session <name>", "Session name to use for repo resolution")
    .option("--force", "Overwrite without confirmation")
    .option("--dry-run", "Show what would be synced without making changes")
    .option("--format <format>", "Rule format to sync (cursor or generic)")
    .action(async (options) => {
      try {
        // Get main workspace path
        const mainWorkspacePath = await getMainWorkspacePath();
        
        // Get session path if not specified
        const sessionWorkspacePath = options.to || await getSessionPath(options.session);

        // Source and destination based on direction
        let sourcePath = options.from;
        let destPath = options.to;
        const direction = options.direction || "to-session";

        if (!sourcePath || !destPath) {
          if (direction === "to-session" || direction === "both") {
            sourcePath = sourcePath || mainWorkspacePath;
            destPath = destPath || sessionWorkspacePath;
          } else if (direction === "from-session") {
            sourcePath = sourcePath || sessionWorkspacePath;
            destPath = destPath || mainWorkspacePath;
          }
        }

        prompts.log.info(`Syncing rules from ${sourcePath} to ${destPath}`);
        
        if (options.dryRun) {
          prompts.log.info("Dry run mode - no changes will be made");
        }

        // Initialize source and destination rule services
        const sourceRuleService = new RuleService(sourcePath);
        const destRuleService = new RuleService(destPath);

        // Get rules to sync
        let rules = await sourceRuleService.listRules({
          format: options.format,
        });

        // Filter to specific rule if requested
        if (options.rule) {
          rules = rules.filter(rule => rule.id === options.rule);
          if (rules.length === 0) {
            prompts.log.error(`Rule '${options.rule}' not found in source workspace`);
            exit(1);
          }
        }

        // If bi-directional, get destination rules too
        if (direction === "both") {
          const destRules = await destRuleService.listRules({
            format: options.format,
          });
          
          // Add rules unique to destination
          const destRuleIds = destRules.map(r => r.id);
          const sourceRuleIds = rules.map(r => r.id);
          
          const uniqueDestRules = destRules.filter(r => !sourceRuleIds.includes(r.id));
          
          if (uniqueDestRules.length > 0) {
            prompts.log.info(`Found ${uniqueDestRules.length} rules unique to destination`);
            rules = [...rules, ...uniqueDestRules];
          }
        }

        prompts.log.info(`Found ${rules.length} rules to sync`);

        // Confirm unless force option provided
        if (!options.force && !options.dryRun) {
          const proceed = await prompts.confirm({
            message: `Sync ${rules.length} rules from ${sourcePath} to ${destPath}?`,
            initialValue: true,
          });

          if (!proceed) {
            prompts.log.info("Sync cancelled");
            exit(0);
          }
        }

        // Sync each rule
        let synced = 0;
        for (const rule of rules) {
          try {
            // Skip syncing back to source in bi-directional mode
            if (direction === "both" && doesRuleExistInSource(rule, sourcePath)) {
              continue;
            }
            
            prompts.log.info(`Syncing rule '${rule.id}'...`);

            // Ensure the destination directory exists
            const destDir = join(destPath, dirname(rule.path.replace(sourcePath, "")));
            if (!options.dryRun) {
              await fs.mkdir(destDir, { recursive: true });
            }

            const destFile = join(destPath, rule.path.replace(sourcePath, ""));
            
            if (options.dryRun) {
              prompts.log.info(`Would copy ${rule.path} to ${destFile}`);
            } else {
              await fs.copyFile(rule.path, destFile);
              prompts.log.success(`Synced rule '${rule.id}'`);
              synced++;
            }
          } catch (error) {
            prompts.log.error(
              `Error syncing rule '${rule.id}': ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }

        if (!options.dryRun) {
          prompts.log.success(`Successfully synced ${synced} rules`);
        }
      } catch (error) {
        prompts.log.error(
          `Error syncing rules: ${error instanceof Error ? error.message : String(error)}`
        );
        exit(1);
      }
    });
}

/**
 * Helper function to get the main workspace path
 */
async function getMainWorkspacePath(): Promise<string> {
  try {
    // Get the main workspace path using git rev-parse
    const output = execSync("git rev-parse --show-toplevel").toString().trim();
    return output;
  } catch (error) {
    throw new Error("Failed to determine main workspace path. Ensure you're in a git repository.");
  }
}

/**
 * Helper function to get the session path
 */
async function getSessionPath(sessionName?: string): Promise<string> {
  try {
    let cmd = "minsky session dir";
    if (sessionName) {
      cmd += ` ${sessionName}`;
    }
    const output = execSync(cmd).toString().trim();
    return output;
  } catch (error) {
    throw new Error("Failed to determine session workspace path. Use --to option to specify manually.");
  }
}

/**
 * Check if a rule exists in the source workspace
 */
function doesRuleExistInSource(rule: any, sourcePath: string): boolean {
  const sourceFile = join(sourcePath, rule.path.split("/rules/")[1]);
  return existsSync(sourceFile);
} 

/**
 * CLI adapter for rules commands
 */
import { Command } from "commander";
import { MinskyError } from "../../errors/index.js";
import { RuleService } from "../../domain/rules.js";
import type { RuleFormat } from "../../domain/rules.js";
import { resolveWorkspacePath } from "../../domain/workspace.js";
import { promises as fs, existsSync } from "fs";
import * as path from "path";

/**
 * Helper to read content from a file if the path exists
 */
export async function readContentFromFileIfExists(contentPath: string): Promise<string> {
  if (existsSync(contentPath)) {
    try {
      return await fs.readFile(contentPath, "utf-8");
    } catch (error) {
      throw new Error(`Failed to read content from file ${contentPath}: ${error}`);
    }
  }
  return contentPath;
}

/**
 * Parse globs string which could be either comma-separated or a JSON array
 */
export function parseGlobs(globsString?: string): string[] | undefined {
  if (!globsString) return undefined;

  // Try to parse as JSON array
  if (globsString.trim().startsWith("[") && globsString.trim().endsWith("]")) {
    try {
      return JSON.parse(globsString);
    } catch (e) {
      // If parsing fails, fall back to comma-separated handling
    }
  }

  // Handle as comma-separated string
  return globsString.split(",").map((g) => g.trim());
}

/**
 * Creates the rules list command
 */
export function createListCommand(): Command {
  return new Command("list")
    .description("List all rules in the workspace")
    .option("--format <format>", "Filter by rule format (cursor or generic)")
    .option("--tag <tag>", "Filter by tag")
    .option("--debug", "Show debug information")
    .option("--json", "Output as JSON")
    .action(async (options: { format?: string; tag?: string; debug?: boolean; json?: boolean }) => {
      try {
        // Resolve workspace path (await the Promise)
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        // Convert CLI options to domain parameters
        const format = options.format as RuleFormat | undefined;
        
        // Call domain function
        const rules = await ruleService.listRules({
          format,
          tag: options.tag,
          debug: options.debug,
        });

        // Format and display output
        if (options.json) {
          console.log(JSON.stringify(rules, null, 2));
        } else {
          if (rules.length === 0) {
            console.log("No rules found");
            return;
          }

          console.log(`Found ${rules.length} rules:`);
          rules.forEach((rule) => {
            console.log(`- ${rule.id} (${rule.format}): ${rule.description || "No description"}`);
          });
        }
      } catch (error) {
        if (error instanceof MinskyError) {
          console.error(`Error: ${error.message}`);
        } else {
          console.error(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
        }
        process.exit(1);
      }
    });
}

/**
 * Creates the rules get command
 */
export function createGetCommand(): Command {
  return new Command("get")
    .description("Get a specific rule by ID")
    .argument("<id>", "Rule ID")
    .option("--format <format>", "Preferred rule format (cursor or generic)")
    .option("--debug", "Show debug information")
    .option("--json", "Output as JSON")
    .action(async (id: string, options: { format?: string; debug?: boolean; json?: boolean }) => {
      try {
        // Resolve workspace path (await the Promise)
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        // Convert CLI options to domain parameters
        const format = options.format as RuleFormat | undefined;
        
        // Call domain function
        const rule = await ruleService.getRule(id, {
          format,
          debug: options.debug,
        });

        // Format and display output
        if (options.json) {
          console.log(JSON.stringify(rule, null, 2));
        } else {
          console.log(`Rule: ${rule.id}`);
          console.log(`Format: ${rule.format}`);
          console.log(`Description: ${rule.description || "No description"}`);
          console.log(`Path: ${rule.path}`);
          
          if (rule.formatNote) {
            console.log(`Format note: ${rule.formatNote}`);
          }

          console.log("\nContent:");
          console.log("----------");
          console.log(rule.content);
          console.log("----------");
        }
      } catch (error) {
        if (error instanceof MinskyError) {
          console.error(`Error: ${error.message}`);
        } else {
          console.error(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
        }
        process.exit(1);
      }
    });
}

/**
 * Creates the rules create command
 */
export function createCreateCommand(): Command {
  return new Command("create")
    .description("Create a new rule")
    .argument("<id>", "Rule ID")
    .option("--format <format>", "Rule format (cursor or generic)", "cursor")
    .option("--description <description>", "Rule description")
    .option("--name <n>", "Rule name")
    .option("--globs <globs>", "File patterns (comma-separated list or JSON array)")
    .option("--always-apply", "Apply this rule to all files")
    .option("--tags <tags>", "Comma-separated list of tags")
    .option("--content <content>", "Rule content or path to content file")
    .option("--overwrite", "Overwrite existing rule if it exists")
    .action(
      async (
        id: string,
        options: {
          format?: string;
          description?: string;
          name?: string;
          globs?: string;
          alwaysApply?: boolean;
          tags?: string;
          content?: string;
          overwrite?: boolean;
        }
      ) => {
        try {
          // Resolve workspace path (await the Promise)
          const workspacePath = await resolveWorkspacePath({});
          const ruleService = new RuleService(workspacePath);

          // Convert CLI options to domain parameters
          const format = (options.format || "cursor") as RuleFormat;
          
          // Read content from file if the path exists
          const content = options.content 
            ? await readContentFromFileIfExists(options.content)
            : "# New Rule\n\nAdd rule content here.";

          // Parse globs using the helper function
          const globs = parseGlobs(options.globs);
          const tags = options.tags ? options.tags.split(",").map((t) => t.trim()) : undefined;

          // Create metadata object
          const meta = {
            name: options.name || id,
            description: options.description,
            globs,
            alwaysApply: options.alwaysApply,
            tags,
          };

          // Call domain function
          const rule = await ruleService.createRule(id, content, meta, {
            format,
            overwrite: options.overwrite,
          });

          console.log(`Rule '${rule.id}' created successfully at ${rule.path}`);
        } catch (error) {
          if (error instanceof MinskyError) {
            console.error(`Error: ${error.message}`);
          } else {
            console.error(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
          }
          process.exit(1);
        }
      }
    );
}

/**
 * Creates the rules update command
 */
export function createUpdateCommand(): Command {
  return new Command("update")
    .description("Update an existing rule")
    .argument("<id>", "Rule ID")
    .option("--format <format>", "Rule format to update (cursor or generic)")
    .option("--description <description>", "New rule description")
    .option("--name <n>", "New rule name")
    .option("--globs <globs>", "New file patterns (comma-separated list or JSON array)")
    .option("--always-apply <boolean>", "Whether to apply this rule to all files")
    .option("--tags <tags>", "New comma-separated list of tags")
    .option("--content <content>", "New rule content or path to content file")
    .action(
      async (
        id: string,
        options: {
          format?: string;
          description?: string;
          name?: string;
          globs?: string;
          alwaysApply?: string;
          tags?: string;
          content?: string;
        }
      ) => {
        try {
          // Resolve workspace path (await the Promise)
          const workspacePath = await resolveWorkspacePath({});
          const ruleService = new RuleService(workspacePath);

          // Convert CLI options to domain parameters
          const format = options.format as RuleFormat | undefined;

          // Build update options objects
          const updateOptions: {
            content?: string;
            meta?: Record<string, any>;
          } = {};

          // Read content from file if the path exists
          if (options.content) {
            updateOptions.content = await readContentFromFileIfExists(options.content);
          }

          // Build meta object only if there are metadata changes
          if (
            options.description ||
            options.name ||
            options.globs ||
            options.alwaysApply !== undefined ||
            options.tags
          ) {
            updateOptions.meta = {};

            if (options.description) updateOptions.meta.description = options.description;
            if (options.name) updateOptions.meta.name = options.name;

            if (options.globs) {
              updateOptions.meta.globs = parseGlobs(options.globs);
            }

            if (options.alwaysApply !== undefined) {
              updateOptions.meta.alwaysApply = options.alwaysApply.toLowerCase() === "true";
            }

            if (options.tags) {
              updateOptions.meta.tags = options.tags.split(",").map((t) => t.trim());
            }
          }

          // Call domain function
          const rule = await ruleService.updateRule(id, updateOptions, {
            format,
          });

          console.log(`Rule '${rule.id}' updated successfully`);
        } catch (error) {
          if (error instanceof MinskyError) {
            console.error(`Error: ${error.message}`);
          } else {
            console.error(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
          }
          process.exit(1);
        }
      }
    );
}

/**
 * Creates the rules search command
 */
export function createSearchCommand(): Command {
  return new Command("search")
    .description("Search for rules")
    .option("--format <format>", "Filter by rule format (cursor or generic)")
    .option("--tag <tag>", "Filter by tag")
    .option("--query <query>", "Search query")
    .option("--json", "Output as JSON")
    .action(async (options: { format?: string; tag?: string; query?: string; json?: boolean }) => {
      try {
        // Resolve workspace path (await the Promise)
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        // Convert CLI options to domain parameters
        const format = options.format as RuleFormat | undefined;
        
        // Call domain function
        const rules = await ruleService.searchRules({
          format,
          tag: options.tag,
          query: options.query,
        });

        // Format and display output
        if (options.json) {
          console.log(JSON.stringify(rules, null, 2));
        } else {
          if (rules.length === 0) {
            console.log("No matching rules found");
            return;
          }

          console.log(`Found ${rules.length} matching rules:`);
          rules.forEach((rule) => {
            console.log(`- ${rule.id} (${rule.format}): ${rule.description || "No description"}`);
          });
        }
      } catch (error) {
        if (error instanceof MinskyError) {
          console.error(`Error: ${error.message}`);
        } else {
          console.error(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
        }
        process.exit(1);
      }
    });
}

/**
 * Creates the main rules command with all subcommands
 */
export function createRulesCommand(): Command {
  const rulesCommand = new Command("rules").description("Rules management operations");

  rulesCommand.addCommand(createListCommand());
  rulesCommand.addCommand(createGetCommand());
  rulesCommand.addCommand(createCreateCommand());
  rulesCommand.addCommand(createUpdateCommand());
  rulesCommand.addCommand(createSearchCommand());

  return rulesCommand;
} 

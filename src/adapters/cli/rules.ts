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
  try {
    // Check if the path exists first
    if (existsSync(contentPath)) {
      // If the path exists, check if it's a file
      const stats = await fs.stat(contentPath);
      if (stats.isFile()) {
        // If it's a file, read its contents
        return await fs.readFile(contentPath, "utf-8");
      } else {
        // If it exists but is not a file (e.g., directory), throw an error
        throw new Error(`Failed to read content from file ${contentPath}: Not a file`);
      }
    }
    // If path doesn't exist, return the original string as content
    return contentPath;
  } catch (error) {
    // Handle missing files by returning the original path as content
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return contentPath;
    }

    // For other errors, throw a clear error message
    throw new Error(`Failed to read content from file ${contentPath}: ${error}`);
  }
}

/**
 * Parse glob patterns from a string, handling both comma-separated values and JSON arrays
 */
export function parseGlobs(globsStr?: string): string[] | undefined {
  if (!globsStr || globsStr.trim() === "") {
    return undefined;
  }

  // Try to parse as JSON array first
  try {
    const parsed = JSON.parse(globsStr);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (e) {
    // If JSON parsing fails, fall back to comma-separated string
  }

  // Handle as comma-separated string
  return globsStr.split(",").map((glob) => glob.trim());
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
          console.error(
            `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
          );
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
          console.error(
            `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        process.exit(1);
      }
    });
}

/**
 * Creates the rules create command
 */
export function createCreateCommand(): Command {
  const command = new Command("create");

  command
    .description("Create a new rule")
    .argument("<id>", "ID of the rule to create")
    .option("-c, --content <content>", "Content of the rule (or path to file containing content)")
    .option("-d, --description <description>", "Description of the rule")
    .option("-n, --name <name>", "Display name of the rule (defaults to ID)")
    .option(
      "-g, --globs <globs>",
      "Comma-separated list or JSON array of glob patterns to match files"
    )
    .option("-t, --tags <tags>", "Comma-separated list of tags for the rule")
    .option("-f, --format <format>", "Format of the rule file (defaults to 'cursor')")
    .option("-o, --overwrite", "Overwrite existing rule if it exists", false)
    .action(async (id, options) => {
      const workspacePath = await resolveWorkspacePath({
        workspace: options.workspace,
      });

      // Get content from file if it exists, otherwise use as-is
      const content = options.content
        ? await readContentFromFileIfExists(options.content)
        : "# New Rule Content\n\nAdd your rule content here.";

      // Parse globs directly using the parseGlobs function
      const globs = options.globs ? parseGlobs(options.globs) : undefined;

      // Create the rule service
      const ruleService = new RuleService(workspacePath);

      // Create the rule
      const meta: Record<string, unknown> = {
        name: options.name || id,
      };

      // Add description if provided
      if (options.description) {
        meta.description = options.description;
      }

      // Add globs if provided
      if (globs) {
        meta.globs = globs;
      }

      // Add tags if provided
      if (options.tags) {
        meta.tags = options.tags.split(",").map((tag: string) => tag.trim());
      }

      // Create the rule
      const rule = await ruleService.createRule(id, content, meta, {
        format: options.format || "cursor",
        overwrite: options.overwrite,
      });

      console.log(`Rule '${id}' created successfully at ${rule.path}`);
    });

  return command;
}

/**
 * Creates the rules update command
 */
export function createUpdateCommand(): Command {
  const command = new Command("update");

  command
    .description("Update an existing rule")
    .argument("<id>", "ID of the rule to update")
    .option(
      "-c, --content <content>",
      "New content of the rule (or path to file containing content)"
    )
    .option("-d, --description <description>", "New description of the rule")
    .option("-n, --name <name>", "New display name of the rule")
    .option(
      "-g, --globs <globs>",
      "Comma-separated list or JSON array of glob patterns to match files"
    )
    .option("-t, --tags <tags>", "Comma-separated list of tags for the rule")
    .option("-f, --format <format>", "Format of the rule file")
    .action(async (id, options) => {
      const workspacePath = await resolveWorkspacePath({
        workspace: options.workspace,
      });

      // Create the rule service
      const ruleService = new RuleService(workspacePath);

      // Set up the update options
      const updateOptions: Record<string, unknown> = {};

      // Add content if provided (reading from file if it exists)
      if (options.content) {
        updateOptions.content = await readContentFromFileIfExists(options.content);
      }

      // Set up metadata updates if any are provided
      const meta: Record<string, unknown> = {};

      if (options.name) {
        meta.name = options.name;
      }

      if (options.description) {
        meta.description = options.description;
      }

      // Parse globs directly using the parseGlobs function
      const globs = options.globs ? parseGlobs(options.globs) : undefined;

      if (globs) {
        meta.globs = globs;
      }

      // Add tags if provided
      if (options.tags) {
        meta.tags = options.tags.split(",").map((tag: string) => tag.trim());
      }

      // Only add meta to the update if we have any metadata properties
      if (Object.keys(meta).length > 0) {
        updateOptions.meta = meta;
      }

      // Update the rule
      const rule = await ruleService.updateRule(id, updateOptions, {
        format: options.format,
      });

      console.log(`Rule '${id}' updated successfully at ${rule.path}`);
    });

  return command;
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
          console.error(
            `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
          );
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

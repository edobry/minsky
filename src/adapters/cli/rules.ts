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
import { 
  handleCliError, 
  outputResult,
  addOutputOptions,
  normalizeOutputOptions
} from "./utils/index.js";

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
  const command = new Command("list")
    .description("List all rules in the workspace")
    .option("--format <format>", "Filter by rule format (cursor or generic)")
    .option("--tag <tag>", "Filter by tag");
  
  // Add shared output options
  addOutputOptions(command);
    
  command.action(async (options: { format?: string; tag?: string; debug?: boolean; json?: boolean }) => {
    try {
      // Normalize output options
      const outputOptions = normalizeOutputOptions(options);
      
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

      // Format and display output using outputResult utility
      outputResult(rules, {
        json: options.json,
        formatter: (rules) => {
          if (rules.length === 0) {
            console.log("No rules found");
            return;
          }

          console.log(`Found ${rules.length} rules:`);
          rules.forEach((rule) => {
            console.log(`- ${rule.id} (${rule.format}): ${rule.description || "No description"}`);
          });
        }
      });
    } catch (error) {
      handleCliError(error);
    }
  });
  
  return command;
}

/**
 * Creates the rules get command
 */
export function createGetCommand(): Command {
  const command = new Command("get")
    .description("Get a specific rule by ID")
    .argument("<id>", "Rule ID")
    .option("--format <format>", "Preferred rule format (cursor or generic)");
  
  // Add shared output options  
  addOutputOptions(command);
    
  command.action(async (id: string, options: { format?: string; debug?: boolean; json?: boolean }) => {
    try {
      // Normalize output options
      const outputOptions = normalizeOutputOptions(options);
      
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

      // Format and display output using outputResult utility
      outputResult(rule, {
        json: options.json,
        formatter: (rule) => {
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
      });
    } catch (error) {
      handleCliError(error);
    }
  });
  
  return command;
}

/**
 * Creates the rules create command
 */
export function createCreateCommand(): Command {
  const command = new Command("create")
    .description("Create a new rule")
    .argument("<id>", "ID of the rule to create")
    .option("-c, --content <content>", "Content of the rule (or path to file containing content)")
    .option("-d, --description <description>", "Description of the rule")
    .option("-n, --name <n>", "Display name of the rule (defaults to ID)")
    .option(
      "-g, --globs <globs>",
      "Comma-separated list or JSON array of glob patterns to match files"
    )
    .option("-t, --tags <tags>", "Comma-separated list of tags for the rule")
    .option("-f, --format <format>", "Format of the rule file (defaults to 'cursor')")
    .option("-o, --overwrite", "Overwrite existing rule if it exists", false);
  
  // Add shared output options
  addOutputOptions(command);
    
  command.action(async (id, options) => {
    try {
      // Normalize output options
      const outputOptions = normalizeOutputOptions(options);
      
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

      // Output result using outputResult utility
      outputResult(rule, {
        json: options.json,
        formatter: () => {
          console.log(`Rule '${id}' created successfully at ${rule.path}`);
        }
      });
    } catch (error) {
      handleCliError(error);
    }
  });

  return command;
}

/**
 * Creates the rules update command
 */
export function createUpdateCommand(): Command {
  const command = new Command("update")
    .description("Update an existing rule")
    .argument("<id>", "ID of the rule to update")
    .option(
      "-c, --content <content>",
      "New content for the rule (or path to file containing content)"
    )
    .option("-d, --description <description>", "New description for the rule")
    .option("-n, --name <n>", "New display name for the rule")
    .option(
      "-g, --globs <globs>",
      "Comma-separated list or JSON array of glob patterns to match files"
    )
    .option("-t, --tags <tags>", "Comma-separated list of tags for the rule")
    .option("-f, --format <format>", "Change the format of the rule")
    .option("--overwrite", "Overwrite the rule content (required for content changes)", false);
  
  // Add shared output options
  addOutputOptions(command);
    
  command.action(async (id, options) => {
    try {
      // Normalize output options
      const outputOptions = normalizeOutputOptions(options);
      
      const workspacePath = await resolveWorkspacePath({});
      
      // Get content from file if it exists, otherwise use as-is
      let content = undefined;
      if (options.content) {
        content = await readContentFromFileIfExists(options.content);
      }

      // Parse globs directly using the parseGlobs function
      const globs = options.globs ? parseGlobs(options.globs) : undefined;

      // Create the rule service
      const ruleService = new RuleService(workspacePath);

      // Gather the metadata updates
      const metaUpdates: Record<string, unknown> = {};

      // Add description update if provided
      if (options.description) {
        metaUpdates.description = options.description;
      }

      // Add name update if provided
      if (options.name) {
        metaUpdates.name = options.name;
      }

      // Add globs update if provided
      if (globs) {
        metaUpdates.globs = globs;
      }

      // Add tags update if provided
      if (options.tags) {
        metaUpdates.tags = options.tags.split(",").map((tag: string) => tag.trim());
      }

      // Update the rule - adjusting parameters based on the API
      const updateOptions = {
        content,
        meta: Object.keys(metaUpdates).length > 0 ? metaUpdates : undefined,
        format: options.format,
        overwrite: options.overwrite || false,
      };
      
      const rule = await ruleService.updateRule(id, updateOptions);

      // Output result using outputResult utility
      outputResult(rule, {
        json: options.json,
        formatter: () => {
          console.log(`Rule '${id}' updated successfully at ${rule.path}`);
        }
      });
    } catch (error) {
      handleCliError(error);
    }
  });

  return command;
}

/**
 * Creates the rules search command
 */
export function createSearchCommand(): Command {
  const command = new Command("search")
    .description("Search rules by title, description, or content")
    .argument("<query>", "Search query")
    .option("--title-only", "Search only in rule titles", false)
    .option("--format <format>", "Filter by rule format (cursor or generic)");
  
  // Add shared output options
  addOutputOptions(command);
    
  command.action(
    async (
      query: string,
      options: {
        titleOnly?: boolean;
        format?: string;
        debug?: boolean;
        json?: boolean;
      }
    ) => {
      try {
        // Normalize output options
        const outputOptions = normalizeOutputOptions(options);
        
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        // Call the domain function - adjusting parameters based on the API
        const searchOptions = {
          format: options.format as RuleFormat | undefined,
          titleOnly: options.titleOnly || false,
          debug: options.debug,
          query, // Include query in options object
        };
        
        const rules = await ruleService.searchRules(searchOptions);

        // Output result using outputResult utility
        outputResult(rules, {
          json: options.json,
          formatter: (rules) => {
            if (rules.length === 0) {
              console.log(`No rules found matching "${query}"`);
              return;
            }

            console.log(`Found ${rules.length} rules matching "${query}":`);
            rules.forEach((rule) => {
              console.log(`- ${rule.id} (${rule.format}): ${rule.description || "No description"}`);
            });
          }
        });
      } catch (error) {
        handleCliError(error);
      }
    }
  );
  
  return command;
}

/**
 * Creates the rules command with all subcommands
 */
export function createRulesCommand(): Command {
  const rulesCommand = new Command("rules").description("Rules management operations");

  // Add all subcommands
  rulesCommand.addCommand(createListCommand());
  rulesCommand.addCommand(createGetCommand());
  rulesCommand.addCommand(createCreateCommand());
  rulesCommand.addCommand(createUpdateCommand());
  rulesCommand.addCommand(createSearchCommand());

  return rulesCommand;
}

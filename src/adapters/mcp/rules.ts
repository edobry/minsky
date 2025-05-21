/**
 * MCP adapter for rules commands
 */
import type { CommandMapper } from "../../mcp/command-mapper.js";
import { z } from "zod";
import { promises as fs, existsSync } from "fs";

// Import centralized descriptions
import {
  DEBUG_DESCRIPTION,
  RULE_CONTENT_DESCRIPTION,
  RULE_DESCRIPTION_DESCRIPTION,
  RULE_NAME_DESCRIPTION,
  RULE_GLOBS_DESCRIPTION,
  RULE_TAGS_DESCRIPTION,
  RULE_FORMAT_DESCRIPTION,
  OVERWRITE_DESCRIPTION
} from "../../utils/option-descriptions.js";

// Import domain functions
import { resolveWorkspacePath } from "../../domain/workspace.js";
import { RuleService } from "../../domain/rules.js";
import type { RuleFormat } from "../../domain/rules.js";

/**
 * Helper to read content from a file if the path exists
 */
async function readContentFromFileIfExists(contentPath: string): Promise<string> {
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
function parseGlobs(globsStr?: string): string[] | undefined {
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
 * Registers rules tools with the MCP command mapper
 */
export function registerRulesTools(commandMapper: CommandMapper): void {
  // List rules command
  commandMapper.addCommand({
    name: "rules.list",
    description: "List all rules in the workspace",
    parameters: z.object({
      format: z.string().optional().describe(RULE_FORMAT_DESCRIPTION),
      tag: z.string().optional().describe("Filter by tag"),
      debug: z.boolean().optional().describe(DEBUG_DESCRIPTION),
    }),
    execute: async (args) => {
      // Resolve workspace path
      const workspacePath = await resolveWorkspacePath({});
      const ruleService = new RuleService(workspacePath);

      // Convert parameters
      const format = args.format as RuleFormat | undefined;

      // Call domain function
      const rules = await ruleService.listRules({
        format,
        tag: args.tag,
        debug: args.debug,
      });

      // Return formatted result
      return rules;
    },
  });

  // Get rule command
  commandMapper.addCommand({
    name: "rules.get",
    description: "Get a specific rule by ID",
    parameters: z.object({
      id: z.string().describe("Rule ID"),
      format: z.string().optional().describe(RULE_FORMAT_DESCRIPTION),
      debug: z.boolean().optional().describe(DEBUG_DESCRIPTION),
    }),
    execute: async (args) => {
      // Resolve workspace path
      const workspacePath = await resolveWorkspacePath({});
      const ruleService = new RuleService(workspacePath);

      // Convert parameters
      const format = args.format as RuleFormat | undefined;

      // Call domain function
      const rule = await ruleService.getRule(args.id, {
        format,
        debug: args.debug,
      });

      // Return the rule object
      return rule;
    },
  });

  // Create rule command
  commandMapper.addCommand({
    name: "rules.create",
    description: "Create a new rule",
    parameters: z.object({
      id: z.string().describe("ID of the rule to create"),
      content: z.string().optional().describe(RULE_CONTENT_DESCRIPTION),
      description: z.string().optional().describe(RULE_DESCRIPTION_DESCRIPTION),
      name: z.string().optional().describe(RULE_NAME_DESCRIPTION),
      globs: z.union([z.string(), z.array(z.string())]).optional().describe(RULE_GLOBS_DESCRIPTION),
      tags: z.string().optional().describe(RULE_TAGS_DESCRIPTION),
      format: z.string().optional().describe(RULE_FORMAT_DESCRIPTION),
      overwrite: z.boolean().optional().describe(OVERWRITE_DESCRIPTION),
    }),
    execute: async (args) => {
      // Resolve workspace path
      const workspacePath = await resolveWorkspacePath({});
      const ruleService = new RuleService(workspacePath);

      // Get content from file if it exists, otherwise use as-is
      const content = args.content
        ? await readContentFromFileIfExists(args.content)
        : "# New Rule Content\n\nAdd your rule content here.";

      // Parse globs (handling both string and array types)
      let globs: string[] | undefined;
      if (typeof args.globs === 'string') {
        globs = parseGlobs(args.globs);
      } else if (Array.isArray(args.globs)) {
        globs = args.globs;
      }

      // Parse tags
      const tags = args.tags ? args.tags.split(',').map(tag => tag.trim()) : undefined;

      // Call domain function
      const rule = await ruleService.createRule({
        id: args.id,
        content,
        description: args.description,
        name: args.name,
        globs,
        tags,
        format: args.format as RuleFormat,
        overwrite: args.overwrite,
      });

      // Return the created rule
      return {
        success: true,
        rule,
      };
    },
  });

  // Update rule command
  commandMapper.addCommand({
    name: "rules.update",
    description: "Update an existing rule",
    parameters: z.object({
      id: z.string().describe("ID of the rule to update"),
      content: z.string().optional().describe(RULE_CONTENT_DESCRIPTION),
      description: z.string().optional().describe(RULE_DESCRIPTION_DESCRIPTION),
      name: z.string().optional().describe(RULE_NAME_DESCRIPTION),
      globs: z.union([z.string(), z.array(z.string())]).optional().describe(RULE_GLOBS_DESCRIPTION),
      tags: z.string().optional().describe(RULE_TAGS_DESCRIPTION),
      format: z.string().optional().describe(RULE_FORMAT_DESCRIPTION),
    }),
    execute: async (args) => {
      // Resolve workspace path
      const workspacePath = await resolveWorkspacePath({});
      const ruleService = new RuleService(workspacePath);
      
      // Process content if provided
      let content: string | undefined;
      if (args.content) {
        content = await readContentFromFileIfExists(args.content);
      }

      // Parse globs (handling both string and array types)
      let globs: string[] | undefined;
      if (typeof args.globs === 'string') {
        globs = parseGlobs(args.globs);
      } else if (Array.isArray(args.globs)) {
        globs = args.globs;
      }

      // Parse tags
      const tags = args.tags ? args.tags.split(',').map(tag => tag.trim()) : undefined;

      // Call domain function
      const rule = await ruleService.updateRule(args.id, {
        content,
        description: args.description,
        name: args.name,
        globs,
        tags,
        format: args.format as RuleFormat,
      });

      // Return the updated rule
      return {
        success: true,
        rule,
      };
    },
  });

  // Search rules command
  commandMapper.addCommand({
    name: "rules.search",
    description: "Search for rules by content",
    parameters: z.object({
      query: z.string().describe("Search query"),
      format: z.string().optional().describe(RULE_FORMAT_DESCRIPTION),
      tag: z.string().optional().describe("Filter by tag"),
      debug: z.boolean().optional().describe(DEBUG_DESCRIPTION),
    }),
    execute: async (args) => {
      // Resolve workspace path
      const workspacePath = await resolveWorkspacePath({});
      const ruleService = new RuleService(workspacePath);

      // Convert parameters
      const format = args.format as RuleFormat | undefined;

      // Call domain function
      const rules = await ruleService.searchRules(args.query, {
        format,
        tag: args.tag,
        debug: args.debug,
      });

      // Return search results
      return rules;
    },
  });
} 

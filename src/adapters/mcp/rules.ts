/**
 * MCP adapter for rules commands
 */
import type { CommandMapper } from "../../mcp/command-mapper.js";
import { z } from "zod";
import { promises as fs, existsSync } from "fs";
// Import parameter schemas
import {
  debugParam,
  ruleFormatParam,
  ruleContentParam,
  ruleDescriptionParam,
  ruleNameParam,
  ruleTagsParam,
  overwriteParam,
  requiredString,
  optionalString,
} from "../../utils/param-schemas.js";

// Import domain functions
import { resolveWorkspacePath } from "../../domain/workspace.js";
import { RuleService } from "../../domain/rules.js";
import type { RuleFormat, UpdateRuleOptions, SearchRuleOptions } from "../../domain/rules.js";
/**
 * Helper to read content from a file if the path exists
 */
async function readContentFromFileIfExists(_contentPath: string): Promise<string> {
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
        throw new Error(`Failed to read _content from file ${contentPath}: Not a file`);
      }
    }
    // If path doesn't exist, return the original string as content
    return contentPath;
  } catch {
    // Handle missing files by returning the original path as content
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return contentPath;
    }

    // For other errors, throw a clear error message
    throw new Error(`Failed to read _content from file ${contentPath}: ${error}`);
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
  } catch {
    // If JSON parsing fails, fall back to comma-separated string
  }

  // Handle as comma-separated string
  return globsStr.split(",").map((glob) => glob.trim());
}

// Type guard for string
function isString(_value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Registers rules tools with the MCP command mapper
 */
export function registerRulesTools(_commandMapper: CommandMapper): void {
  // List rules command
  commandMapper.addCommand({
    name: "rules.list",
    description: "List all rules in the workspace",
    parameters: z.object({
      format: ruleFormatParam,
      tag: optionalString("Filter by tag"),
      debug: debugParam,
    }),
    execute: async (_args): Promise<Record<string, unknown>> => {
      // Resolve workspace path
      const workspacePath = await resolveWorkspacePath({});
      const ruleService = new RuleService(workspacePath);

      // Convert parameters with type safety
      const format = isString(_args.format) ? (_args.format as RuleFormat) : undefined;
      const tag = isString(_args.tag) ? args.tag : undefined;
      const debug = args.debug === true;

      // Call domain function
      const rules = await ruleService.listRules({
        format,
        tag,
        debug,
      });

      // Transform the rules to exclude content
      const transformedRules = rules.map(({ _content, ...rest }) => rest);

      // Return formatted result as a record
      return { rules: transformedRules };
    },
  });

  // Get rule command
  commandMapper.addCommand({
    name: "rules.get",
    description: "Get a specific rule by ID",
    parameters: z.object({
      _id: requiredString("Rule ID"),
      format: ruleFormatParam,
      debug: debugParam,
    }),
    execute: async (_args): Promise<Record<string, unknown>> => {
      // Resolve workspace path
      const workspacePath = await resolveWorkspacePath({});
      const ruleService = new RuleService(workspacePath);

      // Ensure id is string
      if (!isString(_args.id)) {
        throw new Error("Rule ID must be a string");
      }

      // Convert parameters with type safety
      const format = isString(_args.format) ? (_args.format as RuleFormat) : undefined;
      const debug = args.debug === true;

      // Call domain function
      const rule = await ruleService.getRule(_args.id, {
        format,
        debug,
      });

      // Return the rule object as a record
      return { rule };
    },
  });

  // Create rule command
  commandMapper.addCommand({
    name: "rules.create",
    description: "Create a new rule",
    parameters: z.object({
      _id: requiredString("ID of the rule to create"),
      content: ruleContentParam,
      description: ruleDescriptionParam,
      name: ruleNameParam,
      globs: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Glob patterns to match files"),
      tags: ruleTagsParam,
      format: ruleFormatParam,
      overwrite: overwriteParam,
    }),
    execute: async (_args): Promise<Record<string, unknown>> => {
      // Resolve workspace path
      const workspacePath = await resolveWorkspacePath({});
      const ruleService = new RuleService(workspacePath);

      // Ensure id is string
      if (!isString(_args.id)) {
        throw new Error("Rule ID must be a string");
      }

      // Get content from file if it exists, otherwise use as-is
      const content = isString(_args.content)
        ? await readContentFromFileIfExists(_args.content)
        : "# New Rule Content\n\nAdd your rule content here.";

      // Parse globs (handling both string and array types)
      let globs: string[] | undefined;
      if (isString(_args.globs)) {
        globs = parseGlobs(_args.globs);
      } else if (Array.isArray(_args.globs)) {
        globs = args.globs;
      }

      // Parse tags
      const tags = isString(_args.tags) ? args.tags.split(",").map((tag) => tag.trim()) : undefined;

      // Convert formats with type safety
      const format = isString(_args.format) ? (_args.format as RuleFormat) : undefined;
      const overwrite = args.overwrite === true;

      // Call domain function with correct signature
      const rule = await ruleService.createRule(
        _args.id,
        _content,
        {
          description: isString(_args.description) ? args.description : undefined,
          name: isString(_args.name) ? args.name : undefined,
          globs,
          tags,
        },
        {
          format,
          overwrite,
        }
      );

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
      _id: requiredString("ID of the rule to update"),
      content: ruleContentParam,
      description: ruleDescriptionParam,
      name: ruleNameParam,
      globs: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Glob patterns to match files"),
      tags: ruleTagsParam,
      format: ruleFormatParam,
    }),
    execute: async (_args): Promise<Record<string, unknown>> => {
      // Resolve workspace path
      const workspacePath = await resolveWorkspacePath({});
      const ruleService = new RuleService(workspacePath);

      // Ensure id is string
      if (!isString(_args.id)) {
        throw new Error("Rule ID must be a string");
      }

      // Process content if provided
      let content: string | undefined;
      if (isString(_args.content)) {
        content = await readContentFromFileIfExists(_args.content);
      }

      // Parse globs (handling both string and array types)
      let globs: string[] | undefined;
      if (isString(_args.globs)) {
        globs = parseGlobs(_args.globs);
      } else if (Array.isArray(_args.globs)) {
        globs = args.globs;
      }

      // Parse tags
      const tags = isString(_args.tags) ? args.tags.split(",").map((tag) => tag.trim()) : undefined;

      // Convert format with type safety
      const format = isString(_args.format) ? (_args.format as RuleFormat) : undefined;

      // Create update options object
      const updateOptions: UpdateRuleOptions = {
        content,
        meta: {
          description: isString(_args.description) ? args.description : undefined,
          name: isString(_args.name) ? args.name : undefined,
          globs,
          tags,
        },
      };

      // Call domain function with correct signature
      const rule = await ruleService.updateRule(_args.id, updateOptions, {
        format,
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
    description: "Search for rules by _content",
    parameters: z.object({
      query: requiredString("Search query"),
      format: ruleFormatParam,
      tag: optionalString("Filter by tag"),
      debug: debugParam,
    }),
    execute: async (_args): Promise<Record<string, unknown>> => {
      // Resolve workspace path
      const workspacePath = await resolveWorkspacePath({});
      const ruleService = new RuleService(workspacePath);

      // Ensure query is string
      if (!isString(_args.query)) {
        throw new Error("Search query must be a string");
      }

      // Convert parameters with type safety
      const format = isString(_args.format) ? (_args.format as RuleFormat) : undefined;
      const tag = isString(_args.tag) ? args.tag : undefined;

      // Note: debug parameter is accepted in the command but not passed to the domain
      // as SearchRuleOptions doesn't include a debug option

      // Call domain function with correct signature
      const searchOptions: SearchRuleOptions = {
        query: args.query,
        format,
        tag,
      };

      const rules = await ruleService.searchRules(searchOptions);

      // Return search results as a record
      return { rules };
    },
  });
}

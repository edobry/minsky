/**
 * Shared Rules Commands
 *
 * This module contains shared rules command implementations that can be
 * registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 */

import { z } from "zod";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../shared/command-registry.js";
import { RuleService, type RuleFormat } from "../../../domain/rules.js";
import { resolveWorkspacePath } from "../../../domain/workspace.js";
import { readContentFromFileIfExists, parseGlobs } from "../../../utils/rules-helpers.js";
import { log } from "../../../utils/logger.js";
import {
  RULE_FORMAT_DESCRIPTION,
  RULE_TAGS_DESCRIPTION,
  RULE_CONTENT_DESCRIPTION,
  RULE_DESCRIPTION_DESCRIPTION,
  RULE_NAME_DESCRIPTION,
  OVERWRITE_DESCRIPTION,
} from "../../../utils/option-descriptions.js";

/**
 * Parameters for the rules list command
 */
const rulesListCommandParams: CommandParameterMap = {
  format: {
    schema: z.enum(["cursor", "generic"]).optional(),
    description: RULE_FORMAT_DESCRIPTION,
    required: false,
  },
  tag: {
    schema: z.string().optional(),
    description: RULE_TAGS_DESCRIPTION,
    required: false,
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
  debug: {
    schema: z.boolean(),
    description: "Enable debug output",
    required: false,
    defaultValue: false,
  },
};

/**
 * Parameters for the rules get command
 */
const rulesGetCommandParams: CommandParameterMap = {
  id: {
    schema: z.string().min(1),
    description: "Rule ID",
    required: true,
  },
  format: {
    schema: z.enum(["cursor", "generic"]).optional(),
    description: "Preferred rule format (cursor or generic)",
    required: false,
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
  debug: {
    schema: z.boolean(),
    description: "Enable debug output",
    required: false,
    defaultValue: false,
  },
};

/**
 * Parameters for the rules create command
 */
const rulesCreateCommandParams: CommandParameterMap = {
  id: {
    schema: z.string().min(1),
    description: "ID of the rule to create",
    required: true,
  },
  content: {
    schema: z.string(),
    description: RULE_CONTENT_DESCRIPTION,
    required: true,
  },
  description: {
    schema: z.string().optional(),
    description: RULE_DESCRIPTION_DESCRIPTION,
    required: false,
  },
  name: {
    schema: z.string().optional(),
    description: RULE_NAME_DESCRIPTION,
    required: false,
  },
  globs: {
    schema: z.string().optional(),
    description: "Comma-separated list or JSON array of glob patterns to match files",
    required: false,
  },
  tags: {
    schema: z.string().optional(),
    description: RULE_TAGS_DESCRIPTION,
    required: false,
  },
  format: {
    schema: z.enum(["cursor", "generic"]).optional(),
    description: RULE_FORMAT_DESCRIPTION,
    required: false,
  },
  overwrite: {
    schema: z.boolean(),
    description: OVERWRITE_DESCRIPTION,
    required: false,
    defaultValue: false,
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
};

/**
 * Parameters for the rules update command
 */
const rulesUpdateCommandParams: CommandParameterMap = {
  id: {
    schema: z.string().min(1),
    description: "ID of the rule to update",
    required: true,
  },
  content: {
    schema: z.string().optional(),
    description: RULE_CONTENT_DESCRIPTION,
    required: false,
  },
  description: {
    schema: z.string().optional(),
    description: RULE_DESCRIPTION_DESCRIPTION,
    required: false,
  },
  name: {
    schema: z.string().optional(),
    description: RULE_NAME_DESCRIPTION,
    required: false,
  },
  globs: {
    schema: z.string().optional(),
    description: "Comma-separated list or JSON array of glob patterns to match files",
    required: false,
  },
  tags: {
    schema: z.string().optional(),
    description: RULE_TAGS_DESCRIPTION,
    required: false,
  },
  format: {
    schema: z.enum(["cursor", "generic"]).optional(),
    description: RULE_FORMAT_DESCRIPTION,
    required: false,
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
  debug: {
    schema: z.boolean(),
    description: "Enable debug output",
    required: false,
    defaultValue: false,
  },
};

/**
 * Parameters for the rules search command
 */
const rulesSearchCommandParams: CommandParameterMap = {
  query: {
    schema: z.string().optional(),
    description: "Search query term",
    required: false,
  },
  format: {
    schema: z.enum(["cursor", "generic"]).optional(),
    description: "Filter by rule format (cursor or generic)",
    required: false,
  },
  tag: {
    schema: z.string().optional(),
    description: "Filter by tag",
    required: false,
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
  debug: {
    schema: z.boolean(),
    description: "Enable debug output",
    required: false,
    defaultValue: false,
  },
};

/**
 * Register the rules commands in the shared command registry
 */
export function registerRulesCommands(): void {
  // Register rules list command
  sharedCommandRegistry.registerCommand({
    _id: "rules.list",
    category: CommandCategory.RULES,
    name: "list",
    description: "List all rules in the workspace",
    parameters: rulesListCommandParams,
    execute: async (_params: unknown) => {
      log.debug("Executing rules.list _command", { params, context });

      try {
        // Resolve workspace path
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        // Convert parameters
        const format = params.format as RuleFormat | undefined;

        // Call domain function
        const rules = await ruleService.listRules({
          format,
          tag: params.tag,
          debug: params.debug,
        });

        return {
          success: true,
          rules,
        };
      } catch {
        log.error("Failed to list rules", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  });

  // Register rules get command
  sharedCommandRegistry.registerCommand({
    _id: "rules.get",
    category: CommandCategory.RULES,
    name: "get",
    description: "Get a specific rule by ID",
    parameters: rulesGetCommandParams,
    execute: async (_params: unknown) => {
      log.debug("Executing rules.get _command", { params, context });

      try {
        // Resolve workspace path
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        // Convert parameters
        const format = params.format as RuleFormat | undefined;

        // Call domain function
        const rule = await ruleService.getRule(params.id, {
          format,
          debug: params.debug,
        });

        return {
          success: true,
          rule,
        };
      } catch {
        log.error("Failed to get rule", {
          error: error instanceof Error ? error.message : String(error),
          id: params.id,
        });
        throw error;
      }
    },
  });

  // Register rules create command
  sharedCommandRegistry.registerCommand({
    _id: "rules.create",
    category: CommandCategory.RULES,
    name: "create",
    description: "Create a new rule",
    parameters: rulesCreateCommandParams,
    execute: async (_params: unknown) => {
      log.debug("Executing rules.create _command", { params, context });

      try {
        // Resolve workspace path
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        // Process content (could be file path)
        const content = await readContentFromFileIfExists(params._content);

        // Process globs and tags
        const globs = parseGlobs(params.globs);
        const tags = params.tags
          ? params.tags.split(",").map((_tag: unknown) => tag.trim())
          : undefined;

        // Prepare metadata
        const meta = {
          name: params.name || params.id,
          description: params.description,
          globs,
          tags,
        };

        // Convert format
        const format = params.format as RuleFormat | undefined;

        // Call domain function
        const rule = await ruleService.createRule(params.id, _content, meta, {
          format,
          overwrite: params.overwrite,
        });

        return {
          success: true,
          rule,
        };
      } catch {
        log.error("Failed to create rule", {
          error: error instanceof Error ? error.message : String(error),
          id: params.id,
        });
        throw error;
      }
    },
  });

  // Register rules update command
  sharedCommandRegistry.registerCommand({
    _id: "rules.update",
    category: CommandCategory.RULES,
    name: "update",
    description: "Update an existing rule",
    parameters: rulesUpdateCommandParams,
    execute: async (_params: unknown) => {
      log.debug("Executing rules.update _command", { params, context });

      try {
        // Resolve workspace path
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        // Process content if provided (could be file path)
        const content = params.content
          ? await readContentFromFileIfExists(params._content)
          : undefined;

        // Process globs and tags
        const globs = params.globs ? parseGlobs(params.globs) : undefined;
        const tags = params.tags
          ? params.tags.split(",").map((_tag: unknown) => tag.trim())
          : undefined;

        // Prepare metadata updates
        const meta: Record<string, any> = {};

        if (params.name !== undefined) meta.name = params.name;
        if (params.description !== undefined) meta.description = params.description;
        if (globs !== undefined) meta.globs = globs;
        if (tags !== undefined) meta.tags = tags;

        // Convert format
        const format = params.format as RuleFormat | undefined;

        // Call domain function
        const rule = await ruleService.updateRule(
          params.id,
          {
            _content,
            meta: Object.keys(meta).length > 0 ? meta : undefined,
          },
          {
            format,
            debug: params.debug,
          }
        );

        return {
          success: true,
          rule,
        };
      } catch {
        log.error("Failed to update rule", {
          error: error instanceof Error ? error.message : String(error),
          id: params.id,
        });
        throw error;
      }
    },
  });

  // Register rules search command
  sharedCommandRegistry.registerCommand({
    _id: "rules.search",
    category: CommandCategory.RULES,
    name: "search",
    description: "Search for rules by _content or metadata",
    parameters: rulesSearchCommandParams,
    execute: async (_params: unknown) => {
      log.debug("Executing rules.search _command", { params, context });

      try {
        // Resolve workspace path
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        // Convert format
        const format = params.format as RuleFormat | undefined;

        // Call domain function
        const rules = await ruleService.searchRules({
          query: params.query,
          format,
          tag: params.tag,
        });

        return {
          success: true,
          rules,
          query: params.query,
          matchCount: rules.length,
        };
      } catch {
        log.error("Failed to search rules", {
          error: error instanceof Error ? error.message : String(error),
          query: params.query,
        });
        throw error;
      }
    },
  });
}

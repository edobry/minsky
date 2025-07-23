/**
 * Shared Rules Commands
 *
 * This module contains shared rules command implementations that can be
 * registered in the shared command registry and exposed through
 * multiple interfaces (CLI, MCP).
 */

import { z } from "zod";
import { getErrorMessage } from "../../../errors/index";
import {
  sharedCommandRegistry,
  CommandCategory,
  type CommandExecutionContext,
  type CommandParameterMap,
} from "../../shared/command-registry";
import { RuleService, type RuleFormat } from "../../../domain/rules";
import { createRuleTemplateService } from "../../../domain/rules/rule-template-service";
import { type RuleGenerationConfig } from "../../../domain/rules/template-system";
import { resolveWorkspacePath } from "../../../domain/workspace";
import { readContentFromFileIfExists, parseGlobs } from "../../../utils/rules-helpers";
import { log } from "../../../utils/logger";
import {
  RULE_FORMAT_DESCRIPTION,
  RULE_TAGS_DESCRIPTION,
  RULE_CONTENT_DESCRIPTION,
  RULE_DESCRIPTION_DESCRIPTION,
  RULE_NAME_DESCRIPTION,
  OVERWRITE_DESCRIPTION,
} from "../../../utils/option-descriptions";

/**
 * Parameters for the rules list command
 */
type RulesListParams = {
  format?: "cursor" | "generic";
  tag?: string;
  json?: boolean;
  debug?: boolean;
};

const rulesListCommandParams: CommandParameterMap = {
  format: {
    schema: z.string().optional(),
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
type RulesGetParams = {
  id: string;
  format?: "cursor" | "generic";
  json?: boolean;
  debug?: boolean;
};

const rulesGetCommandParams: CommandParameterMap = {
  id: {
    schema: z.string().min(1),
    description: "Rule ID",
    required: true,
  },
  format: {
    schema: z.string().optional(),
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
 * Parameters for the rules generate command
 */
type RulesGenerateParams = {
  interface?: "cli" | "mcp" | "hybrid";
  rules?: string;
  outputDir?: string;
  dryRun?: boolean;
  overwrite?: boolean;
  format?: "cursor" | "openai";
  preferMcp?: boolean;
  mcpTransport?: "stdio" | "http";
  json?: boolean;
  debug?: boolean;
};

const rulesGenerateCommandParams: CommandParameterMap = {
  interface: {
    schema: z.enum(["cli", "mcp", "hybrid"]),
    description: "Interface preference for generated rules (cli, mcp, or hybrid)",
    required: false,
    defaultValue: "cli",
  },
  rules: {
    schema: z.string().optional(),
    description: "Comma-separated list of specific rule templates to generate (if not specified, generates all available templates)",
    required: false,
  },
  outputDir: {
    schema: z.string().optional(),
    description: "Output directory for generated rules (defaults to .cursor/rules for cursor format, .ai/rules for openai format)",
    required: false,
  },
  dryRun: {
    schema: z.boolean(),
    description: "Show what would be generated without actually creating files",
    required: false,
    defaultValue: false,
  },
  overwrite: {
    schema: z.boolean(),
    description: OVERWRITE_DESCRIPTION,
    required: false,
    defaultValue: false,
  },
  format: {
    schema: z.enum(["cursor", "openai"]),
    description: "Rule format for file system organization (cursor or openai)",
    required: false,
    defaultValue: "cursor",
  },
  preferMcp: {
    schema: z.boolean(),
    description: "In hybrid mode, prefer MCP commands over CLI commands",
    required: false,
    defaultValue: false,
  },
  mcpTransport: {
    schema: z.enum(["stdio", "http"]),
    description: "MCP transport method (only relevant when interface is mcp or hybrid)",
    required: false,
    defaultValue: "stdio",
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
type RulesCreateParams = {
  id: string;
  content: string;
  description?: string;
  name?: string;
  globs?: string;
  tags?: string;
  format?: "cursor" | "generic";
  overwrite?: boolean;
  json?: boolean;
};

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
    schema: z.string().optional(),
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
type RulesUpdateParams = {
  id: string;
  content?: string;
  description?: string;
  name?: string;
  globs?: string;
  tags?: string;
  format?: "cursor" | "generic";
  json?: boolean;
  debug?: boolean;
};

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
    schema: z.string().optional(),
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
type RulesSearchParams = {
  query?: string;
  tag?: string;
  format?: "cursor" | "generic";
  json?: boolean;
  debug?: boolean;
};

const rulesSearchCommandParams: CommandParameterMap = {
  query: {
    schema: z.string().optional(),
    description: "Search query term",
    required: false,
  },
  format: {
    schema: z.string().optional(),
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
    id: "rules.list",
    category: CommandCategory.RULES,
    name: "list",
    description: "List all rules in the workspace",
    parameters: rulesListCommandParams,
    execute: async (params: RulesListParams) => {
      log.debug("Executing rules.list command", { params });

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
      } catch (error) {
        log.error("Failed to list rules", {
          error: getErrorMessage(error),
        });
        throw error;
      }
    },
  });

  // Register rules get command
  sharedCommandRegistry.registerCommand({
    id: "rules.get",
    category: CommandCategory.RULES,
    name: "get",
    description: "Get a specific rule by ID",
    parameters: rulesGetCommandParams,
    execute: async (params: any) => {
      log.debug("Executing rules.get command", { params });
        
      const typedParams = params as RulesGetParams;

      try {
        // Resolve workspace path
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        // Convert parameters
        const format = typedParams.format as RuleFormat | undefined;

        // Call domain function
        const rule = await ruleService.getRule(typedParams.id, {
          format,
          debug: typedParams.debug,
        });

        return {
          success: true,
          rule,
        };
      } catch (error) {
        log.error("Failed to get rule", {
          error: getErrorMessage(error),
          id: typedParams.id,
        });
        throw error;
      }
    },
  });

  // Register rules generate command
  sharedCommandRegistry.registerCommand({
    id: "rules.generate",
    category: CommandCategory.RULES,
    name: "generate",
    description: "Generate new rules from templates",
    parameters: rulesGenerateCommandParams,
    execute: async (params: any) => {
      log.debug("Executing rules.generate command", { params });
        
      const typedParams = params as RulesGenerateParams;

      try {
        // Resolve workspace path
        const workspacePath = await resolveWorkspacePath({});
        const ruleTemplateService = createRuleTemplateService(workspacePath);
         
        // Register templates
        await ruleTemplateService.registerDefaultTemplates();

        // Convert parameters to RuleGenerationConfig
        const config: RuleGenerationConfig = {
          interface: (typedParams.interface || "cli") as "cli" | "mcp" | "hybrid",
          mcpEnabled: typedParams.interface === "mcp" || typedParams.interface === "hybrid",
          mcpTransport: (typedParams.mcpTransport || "stdio") as "stdio" | "http",
          preferMcp: typedParams.preferMcp || false,
          ruleFormat: (typedParams.format || "cursor") as "cursor" | "openai",
          outputDir: typedParams.outputDir || (typedParams.format === "cursor" ? ".cursor/rules" : ".ai/rules"),
        };

        const selectedRules = typedParams.rules ? typedParams.rules.split(",").map(t => t.trim()) : undefined;
        const dryRun = typedParams.dryRun || false;
        const overwrite = typedParams.overwrite || false;

        // Call domain function
        const result = await ruleTemplateService.generateRules({
          config,
          selectedRules,
          dryRun,
          overwrite,
        });

        return {
          success: result.success,
          rules: result.rules,
          errors: result.errors,
          generated: result.rules.length,
        };
      } catch (error) {
        log.error("Failed to generate rules", {
          error: getErrorMessage(error),
          interface: typedParams.interface,
          selectedRules: typedParams.rules,
          dryRun: typedParams.dryRun,
          overwrite: typedParams.overwrite,
        });
        throw error;
      }
    },
  });

  // Register rules create command
  sharedCommandRegistry.registerCommand({
    id: "rules.create",
    category: CommandCategory.RULES,
    name: "create",
    description: "Create a new rule",
    parameters: rulesCreateCommandParams,
    execute: async (params: any) => {
      log.debug("Executing rules.create command", { params });
        
      const typedParams = params as RulesCreateParams;

      try {
        // Resolve workspace path
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        // Process content (could be file path)
        const content = await readContentFromFileIfExists(typedParams.content);

        // Process globs and tags
        const globs = parseGlobs(typedParams.globs);
        const tags = typedParams.tags
          ? typedParams.tags.split(",").map((tag: string) => tag.trim())
          : undefined;

        // Prepare metadata
        const meta = {
          name: typedParams.name || typedParams.id,
          description: typedParams.description,
          globs,
          tags,
        };

        // Convert format
        const format = typedParams.format as RuleFormat | undefined;

        // Call domain function
        const rule = await ruleService.createRule(typedParams.id, content, meta, {
          format,
          overwrite: typedParams.overwrite,
        });

        return {
          success: true,
          rule,
        };
      } catch (error) {
        log.error("Failed to create rule", {
          error: getErrorMessage(error),
          id: typedParams.id,
        });
        throw error;
      }
    },
  });

  // Register rules update command
  sharedCommandRegistry.registerCommand({
    id: "rules.update",
    category: CommandCategory.RULES,
    name: "update",
    description: "Update an existing rule",
    parameters: rulesUpdateCommandParams,
    execute: async (params: any) => {
      log.debug("Executing rules.update command"!, { params });
      
      const typedParams = params as RulesUpdateParams;

      try {
        // Resolve workspace path
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        // Process content if provided (could be file path)
        const content = typedParams.content
          ? await readContentFromFileIfExists(typedParams.content)
          : undefined;

        // Process globs and tags
        const globs = typedParams.globs ? parseGlobs(typedParams.globs) : undefined;
        const tags = typedParams.tags
          ? typedParams.tags.split(",").map((tag: string) => tag.trim())
          : undefined;

        // Prepare metadata updates
        const meta: Record<string, any> = {};

        if (typedParams.name !== undefined) meta.name = typedParams.name;
        if (typedParams.description !== undefined) meta.description = typedParams.description;
        if (globs !== undefined) meta.globs = globs;
        if (tags !== undefined) meta.tags = tags;

        // Convert format
        const format = typedParams.format as RuleFormat | undefined;

        // Call domain function
        const rule = await ruleService.updateRule(
          typedParams.id,
          {
            content,
            meta: Object.keys(meta).length > 0 ? meta : undefined,
          },
          {
            format,
            debug: typedParams.debug,
          }
        );

        return {
          success: true,
          rule,
        };
      } catch (error) {
        log.error("Failed to update rule", {
          error: getErrorMessage(error),
          id: typedParams.id,
        });
        throw error;
      }
    },
  });

  // Register rules search command
  sharedCommandRegistry.registerCommand({
    id: "rules.search",
    category: CommandCategory.RULES,
    name: "search",
    description: "Search for rules by content or metadata",
    parameters: rulesSearchCommandParams,
    execute: async (params: any) => {
      log.debug("Executing rules.search command", { params });

      try {
        // Resolve workspace path
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        // Convert parameters
        const format = params.format as RuleFormat | undefined;

        // Call domain function
        const rules = await ruleService.searchRules({
          format,
          tag: params.tag,
          query: params.query,
        });

        return {
          success: true,
          rules,
        };
      } catch (error) {
        log.error("Failed to search rules", {
          error: getErrorMessage(error as any),
          query: (params as any).query,
        });
        throw error;
      }
    },
  });
}

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
} from "../command-registry";
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
import { CommonParameters, RulesParameters, composeParams } from "../common-parameters";
import { getConfiguration } from "../../../domain/configuration";
import fs from "fs/promises";
import { getEmbeddingDimension } from "../../../domain/ai/embedding-models";
import { createEmbeddingServiceFromConfig } from "../../../domain/ai/embedding-service-factory";
import { PostgresVectorStorage } from "../../../domain/storage/vector/postgres-vector-storage";

/**
 * Parameters for the rules list command
 */
type RulesListParams = {
  format?: "cursor" | "generic";
  tag?: string;
  json?: boolean;
  debug?: boolean;
};

const rulesListCommandParams: CommandParameterMap = composeParams(
  {
    format: RulesParameters.format,
    tag: RulesParameters.tag,
  },
  {
    json: CommonParameters.json,
    debug: CommonParameters.debug,
  }
);

/**
 * Parameters for the rules index-embeddings command
 */
type RulesIndexEmbeddingsParams = {
  limit?: number;
  json?: boolean;
  debug?: boolean;
  force?: boolean;
};

const rulesIndexEmbeddingsParams: CommandParameterMap = composeParams(
  {
    limit: {
      schema: z.number().int().positive().optional(),
      description: "Limit number of rules to index (for debugging)",
      required: false,
    },
    force: {
      schema: z.boolean(),
      description: "Force reindex even if content hash matches",
      required: false,
      defaultValue: false,
    },
  },
  {
    json: CommonParameters.json,
    debug: CommonParameters.debug,
  }
);

/**
 * Parameters for the rules get command
 */
type RulesGetParams = {
  id: string;
  format?: "cursor" | "generic";
  json?: boolean;
  debug?: boolean;
};

const rulesGetCommandParams: CommandParameterMap = composeParams(
  {
    id: RulesParameters.id,
    format: RulesParameters.format,
  },
  {
    json: CommonParameters.json,
    debug: CommonParameters.debug,
  }
);

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
    description:
      "Comma-separated list of specific rule templates to generate (if not specified, generates all available templates)",
    required: false,
  },
  outputDir: {
    schema: z.string().optional(),
    description:
      "Output directory for generated rules (defaults to .cursor/rules for cursor format, .ai/rules for openai format)",
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

const rulesCreateCommandParams: CommandParameterMap = composeParams(
  {
    id: RulesParameters.id,
    content: RulesParameters.content,
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
    globs: RulesParameters.globs,
    tags: RulesParameters.tags,
    format: RulesParameters.format,
  },
  {
    overwrite: CommonParameters.overwrite,
    json: CommonParameters.json,
  }
);

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

const rulesUpdateCommandParams: CommandParameterMap = composeParams(
  {
    id: RulesParameters.id,
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
    globs: RulesParameters.globs,
    tags: RulesParameters.tags,
    format: RulesParameters.format,
  },
  {
    json: CommonParameters.json,
    debug: CommonParameters.debug,
  }
);

/**
 * Parameters for the rules search command
 */
type RulesSearchParams = {
  query?: string;
  tag?: string;
  format?: "cursor" | "generic";
  limit?: number;
  threshold?: number;
  details?: boolean;
  json?: boolean;
  debug?: boolean;
};

const rulesSearchCommandParams: CommandParameterMap = composeParams(
  {
    query: RulesParameters.query,
    format: RulesParameters.format,
    tag: RulesParameters.tag,
    limit: {
      schema: z.number().int().positive().default(10),
      help: "Max number of results",
      required: false,
    },
    threshold: {
      schema: z.number().optional(),
      help: "Optional distance threshold (lower is closer)",
      required: false,
    },
    details: {
      schema: z.boolean().default(false),
      help: "Show detailed output including scores and diagnostics",
      required: false,
    },
  },
  {
    json: CommonParameters.json,
    debug: CommonParameters.debug,
  }
);

/**
 * Register the rules commands in the shared command registry
 */
export function registerRulesCommands(registry?: typeof sharedCommandRegistry): void {
  const targetRegistry = registry || sharedCommandRegistry;
  // Register rules index-embeddings command
  targetRegistry.registerCommand({
    id: "rules.index-embeddings",
    category: CommandCategory.RULES,
    name: "index-embeddings",
    description: "Generate and store embeddings for rules (rules_embeddings)",
    parameters: rulesIndexEmbeddingsParams,
    execute: async (params: RulesIndexEmbeddingsParams, ctx?: CommandExecutionContext) => {
      try {
        // Use the proper service abstraction (same pattern as tasks)
        const { createRuleSimilarityService } = await import(
          "../../../domain/rules/rule-similarity-service"
        );
        const service = await createRuleSimilarityService();

        // Get list of rules to index
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);
        const rules = await ruleService.listRules({});

        // Apply limit for debugging
        const slice = params.limit ? rules.slice(0, params.limit) : rules;

        if (slice.length === 0) {
          if (params.json || ctx?.format === "json") {
            return { success: true, indexed: 0, skipped: 0, total: 0 };
          }
          log.cli("No rules found to index.");
          return { success: true };
        }

        let indexed = 0;
        let skipped = 0;
        const start = Date.now();

        if (!(params.json || ctx?.format === "json")) {
          log.cli(`Indexing embeddings for ${slice.length} rule(s)...`);
        }

        // Index each rule using the service
        for (const rule of slice) {
          if (!(params.json || ctx?.format === "json")) {
            log.cli(`- ${rule.id}`);
          }

          try {
            const changed = await service.indexRule(rule.id);
            if (changed) {
              indexed++;
            } else {
              skipped++;
            }
          } catch (error) {
            skipped++;
            if (params.debug) {
              log.cliError(`Error indexing rule ${rule.id}: ${getErrorMessage(error as any)}`);
            }
          }
        }

        const elapsed = Date.now() - start;

        if (params.json || ctx?.format === "json") {
          return {
            success: true,
            indexed,
            skipped,
            total: slice.length,
            ms: elapsed,
          };
        }

        log.cli(
          `✅ Indexed ${indexed}/${slice.length} rule(s) in ${elapsed}ms (skipped errors: ${skipped})`
        );
        return { success: true };
      } catch (error) {
        const message = getErrorMessage(error as any);
        if (params.json || ctx?.format === "json") {
          return { success: false, error: message };
        }
        log.cliError(`Failed to index rule embeddings: ${message}`);
        throw error;
      }
    },
  });
  // Register rules list command
  targetRegistry.registerCommand({
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

        // Transform rules to exclude content field for better usability
        const rulesWithoutContent = rules.map(({ content, ...rule }) => rule);

        return {
          success: true,
          rules: rulesWithoutContent,
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
  targetRegistry.registerCommand({
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
  targetRegistry.registerCommand({
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
          outputDir:
            typedParams.outputDir ||
            (typedParams.format === "cursor" ? ".cursor/rules" : ".ai/rules"),
        };

        const selectedRules = typedParams.rules
          ? typedParams.rules.split(",").map((t) => t.trim())
          : undefined;
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
  targetRegistry.registerCommand({
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

        // Create FS dependencies for rules helpers (same pattern as RuleService)
        const fsDeps = {
          fsPromises: await import("fs/promises"),
          existsSyncFn: (await import("fs")).existsSync,
        };

        // Process content (could be file path)
        const content = await readContentFromFileIfExists(typedParams.content, fsDeps);

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
  targetRegistry.registerCommand({
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

        // Create FS dependencies for rules helpers (same pattern as RuleService)
        const fsDeps = {
          fsPromises: await import("fs/promises"),
          existsSyncFn: (await import("fs")).existsSync,
        };

        // Process content if provided (could be file path)
        const content = typedParams.content
          ? await readContentFromFileIfExists(typedParams.content, fsDeps)
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
  targetRegistry.registerCommand({
    id: "rules.search",
    category: CommandCategory.RULES,
    name: "search",
    description: "Search for rules by content or metadata",
    parameters: rulesSearchCommandParams,
    execute: async (params: any, ctx?: CommandExecutionContext) => {
      log.debug("Executing rules.search command", { params });

      try {
        // Resolve workspace path
        const workspacePath = await resolveWorkspacePath({});

        // Use similarity service (consistent with tasks.search)
        const { createRuleSimilarityService } = await import(
          "../../../domain/rules/rule-similarity-service"
        );
        const service = await createRuleSimilarityService();

        const query = params.query;
        const limit = params.limit ?? 10;
        const threshold = params.threshold;

        // Emit progress message like tasks.search does
        const quiet = Boolean(params.quiet);
        const json = Boolean(params.json) || ctx?.format === "json";
        if (!quiet && !json && query) {
          log.cliWarn(`Searching for rules matching: "${query}" ...`);
        }

        // Perform similarity search (consistent with tasks.search)
        const results = await service.searchByText(query, limit, threshold);

        // Optional human-friendly diagnostics (consistent with tasks.search)
        if (params.details) {
          try {
            const cfg = await (await import("../../../domain/configuration")).getConfiguration();
            const provider =
              (cfg as any).embeddings?.provider || (cfg as any).ai?.defaultProvider || "openai";
            const model = (cfg as any).embeddings?.model || "text-embedding-3-small";
            const effThreshold = threshold ?? "(default)";
            log.cliWarn(`Search provider: ${provider}`);
            log.cliWarn(`Model: ${model}`);
            log.cliWarn(`Limit: ${limit}`);
            log.cliWarn(`Threshold: ${String(effThreshold)}`);
          } catch {
            // ignore diagnostics failures
          }
        }

        // Enhance results with rule details (similar to tasks.search)
        const enhancedResults = [];
        for (const result of results) {
          try {
            // Get full rule details
            const { ModularRulesService } = await import(
              "../../../domain/rules/rules-service-modular"
            );
            const rulesService = new ModularRulesService(workspacePath);
            const rule = await rulesService.getRule(result.id);

            enhancedResults.push({
              id: result.id,
              score: result.score,
              name: rule.name || result.id,
              description: rule.description || rule.name || "",
              format: rule.format || "",
            });
          } catch (error) {
            // Rule not found or error loading rule, include minimal info
            enhancedResults.push({
              id: result.id,
              score: result.score,
              name: result.id,
              description: "",
              format: "",
            });
          }
        }

        return {
          success: true,
          count: enhancedResults.length,
          results: enhancedResults, // Use same format as tasks.search
          details: params.details,
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

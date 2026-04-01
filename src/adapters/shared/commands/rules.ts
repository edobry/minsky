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
import type { EnhancedSearchResult } from "./similarity-command-factory";

/**
 * Rule-style result formatter for similarity search results
 * Format: "1. rule-name [cursor] - Description of the rule"
 */
function ruleStyleFormatter(
  result: EnhancedSearchResult,
  index: number,
  showScore: boolean
): string {
  const name = result.name || result.id;
  const format = (result as any).format;
  const formatPart = format ? ` [${format}]` : "";
  const desc = result.description ? ` - ${result.description}` : "";
  const scorePart =
    showScore && result.score !== undefined ? `\nScore: ${result.score.toFixed(3)}` : "";
  return `${index + 1}. ${name}${formatPart}${desc}${scorePart}`;
}
import { readContentFromFileIfExists, parseGlobs } from "../../../utils/rules-helpers";
import { log } from "../../../utils/logger";
import {
  RULE_CONTENT_DESCRIPTION,
  RULE_DESCRIPTION_DESCRIPTION,
  RULE_NAME_DESCRIPTION,
  OVERWRITE_DESCRIPTION,
} from "../../../utils/option-descriptions";
import { CommonParameters, RulesParameters, composeParams } from "../common-parameters";
import {
  enableRule,
  disableRule,
  getRulesConfig,
  getRulesPresets,
  migrateRules,
  indexRuleEmbeddings,
  searchRulesEnhanced,
  listRulesFiltered,
  compileRules,
} from "../../../domain/rules/rules-command-operations";

/**
 * Parameters for the rules list command
 */
type RulesListParams = {
  format?: "cursor" | "generic";
  tag?: string;
  since?: string;
  until?: string;
  json?: boolean;
  debug?: boolean;
};

const rulesListCommandParams: CommandParameterMap = composeParams(
  {
    format: RulesParameters.format,
    tag: RulesParameters.tag,
    since: {
      schema: z.string().optional(),
      description:
        "Optional: filter by updated time (YYYY-MM-DD or 7d/24h/30m). " +
        "Currently not enforced due to missing timestamps.",
      required: false,
    },
    until: {
      schema: z.string().optional(),
      description:
        "Optional: filter by updated time (YYYY-MM-DD or 7d/24h/30m). " +
        "Currently not enforced due to missing timestamps.",
      required: false,
    },
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
  format?: RuleFormat;
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
      "Comma-separated list of specific rule templates to generate " +
      "(if not specified, generates all available templates)",
    required: false,
  },
  outputDir: {
    schema: z.string().optional(),
    description:
      "Output directory for generated rules (defaults to .cursor/rules " +
      "for cursor format, .ai/rules for openai format)",
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
    schema: z.enum(["cursor", "generic", "minsky"]),
    description: "Rule format for file system organization (cursor or generic)",
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
        const workspacePath = await resolveWorkspacePath({});
        const json = Boolean(params.json) || ctx?.format === "json";

        const result = await indexRuleEmbeddings({
          workspacePath,
          limit: params.limit,
          force: params.force,
          json,
          debug: params.debug,
        });

        if (json) {
          return result;
        }

        if (result.indexed === 0 && result.skipped === 0 && result.total === 0) {
          log.cli("No rules found to index.");
          return { success: true };
        }

        log.cli(
          `\u2705 Indexed ${result.indexed}/${result.total} rule(s) ` +
            `in ${result.ms}ms (skipped errors: ${result.skipped})`
        );
        return { success: true };
      } catch (error) {
        const message = getErrorMessage(error as any);
        if (Boolean(params.json) || ctx?.format === "json") {
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
        const workspacePath = await resolveWorkspacePath({});
        return await listRulesFiltered({
          workspacePath,
          format: params.format as RuleFormat | undefined,
          tag: params.tag,
          since: params.since,
          until: params.until,
          debug: params.debug,
        });
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
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        const format = typedParams.format as RuleFormat | undefined;

        const rule = await ruleService.getRule(typedParams.id, {
          format,
          debug: typedParams.debug,
        });

        return { success: true, rule };
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
        const workspacePath = await resolveWorkspacePath({});
        const ruleTemplateService = createRuleTemplateService(workspacePath);

        await ruleTemplateService.registerDefaultTemplates();

        const config: RuleGenerationConfig = {
          interface: (typedParams.interface || "cli") as "cli" | "mcp" | "hybrid",
          mcpEnabled: typedParams.interface === "mcp" || typedParams.interface === "hybrid",
          mcpTransport: (typedParams.mcpTransport || "stdio") as "stdio" | "http",
          preferMcp: typedParams.preferMcp || false,
          ruleFormat: (typedParams.format || "cursor") as RuleFormat,
          outputDir:
            typedParams.outputDir ||
            (typedParams.format === "cursor" ? ".cursor/rules" : ".ai/rules"),
        };

        const selectedRules = typedParams.rules
          ? typedParams.rules.split(",").map((t) => t.trim())
          : undefined;
        const dryRun = typedParams.dryRun || false;
        const overwrite = typedParams.overwrite || false;

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
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        const content = await readContentFromFileIfExists(typedParams.content);

        const globs = parseGlobs(typedParams.globs);
        const tags = typedParams.tags
          ? typedParams.tags.split(",").map((tag: string) => tag.trim())
          : undefined;

        const meta = {
          name: typedParams.name || typedParams.id,
          description: typedParams.description,
          globs,
          tags,
        };

        const format = typedParams.format as RuleFormat | undefined;

        const rule = await ruleService.createRule(typedParams.id, content, meta, {
          format,
          overwrite: typedParams.overwrite,
        });

        return { success: true, rule };
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
      log.debug("Executing rules.update command", { params });

      const typedParams = params as RulesUpdateParams;

      try {
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        const content = typedParams.content
          ? await readContentFromFileIfExists(typedParams.content)
          : undefined;

        const globs = typedParams.globs ? parseGlobs(typedParams.globs) : undefined;
        const tags = typedParams.tags
          ? typedParams.tags.split(",").map((tag: string) => tag.trim())
          : undefined;

        const meta: Record<string, any> = {};
        if (typedParams.name !== undefined) meta.name = typedParams.name;
        if (typedParams.description !== undefined) meta.description = typedParams.description;
        if (globs !== undefined) meta.globs = globs;
        if (tags !== undefined) meta.tags = tags;

        const format = typedParams.format as RuleFormat | undefined;

        const rule = await ruleService.updateRule(
          typedParams.id,
          {
            content,
            meta: Object.keys(meta).length > 0 ? meta : undefined,
          },
          { format, debug: typedParams.debug }
        );

        return { success: true, rule };
      } catch (error) {
        log.error("Failed to update rule", {
          error: getErrorMessage(error),
          id: typedParams.id,
        });
        throw error;
      }
    },
  });

  // Register rules compile command
  targetRegistry.registerCommand({
    id: "rules.compile",
    category: CommandCategory.RULES,
    name: "compile",
    description: "Compile rules into a monolithic file (e.g., AGENTS.md or CLAUDE.md)",
    parameters: {
      target: {
        schema: z.string(),
        description:
          "Target file type to compile to (e.g., agents.md, claude.md). " +
          "Defaults to agents.md.",
        required: false,
        defaultValue: "agents.md",
      },
      output: {
        schema: z.string().optional(),
        description: "Output file path (defaults to the target's default output path)",
        required: false,
      },
      dryRun: {
        schema: z.boolean(),
        description: "Print compiled content to output without writing to file",
        required: false,
        defaultValue: false,
      },
      check: {
        schema: z.boolean(),
        description:
          "Check if the output file is up-to-date (staleness detection). " +
          "Exits non-zero if stale.",
        required: false,
        defaultValue: false,
      },
    },
    execute: async (params: any, _ctx?: CommandExecutionContext) => {
      log.debug("Executing rules.compile command", { params });

      const typedParams = params as {
        target?: string;
        output?: string;
        dryRun?: boolean;
        check?: boolean;
      };

      try {
        const workspacePath = await resolveWorkspacePath({});
        return await compileRules({
          workspacePath,
          target: typedParams.target,
          output: typedParams.output,
          dryRun: typedParams.dryRun,
          check: typedParams.check,
        });
      } catch (error) {
        log.error("Failed to compile rules", {
          error: getErrorMessage(error),
          target: typedParams.target || "agents.md",
        });
        throw error;
      }
    },
  });

  // Register rules migrate command
  targetRegistry.registerCommand({
    id: "rules.migrate",
    category: CommandCategory.RULES,
    name: "migrate",
    description: "Migrate rules from .cursor/rules/ to .minsky/rules/",
    parameters: {
      dryRun: {
        schema: z.boolean(),
        description: "Show what would be migrated without doing it",
        required: false,
        defaultValue: false,
      },
      force: {
        schema: z.boolean(),
        description: "Overwrite existing files in destination",
        required: false,
        defaultValue: false,
      },
    },
    execute: async (params: { dryRun?: boolean; force?: boolean }) => {
      log.debug("Executing rules.migrate command", { params });

      try {
        const workspacePath = await resolveWorkspacePath({});
        return await migrateRules({
          workspacePath,
          dryRun: params.dryRun || false,
          force: params.force || false,
        });
      } catch (error) {
        log.error("Failed to migrate rules", {
          error: getErrorMessage(error as any),
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
        const workspacePath = await resolveWorkspacePath({});

        const query = params.query;
        const limit = params.limit ?? 10;
        const threshold = params.threshold;

        // Emit progress message
        const quiet = Boolean(params.quiet);
        const json = Boolean(params.json) || ctx?.format === "json";
        if (!quiet && !json && query) {
          log.cliWarn(`Searching for rules matching: "${query}" ...`);
        }

        // Optional human-friendly diagnostics
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

        const enhancedResults = await searchRulesEnhanced({
          workspacePath,
          query,
          limit,
          threshold,
        });

        return {
          success: true,
          count: enhancedResults.length,
          results: enhancedResults,
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

  // ─── Rule selection commands ──────────────────────────────────

  // Register rules.enable command
  targetRegistry.registerCommand({
    id: "rules.enable",
    category: CommandCategory.RULES,
    name: "enable",
    description: "Add a rule ID to the enabled list in the project config",
    parameters: {
      ruleId: {
        schema: z.string(),
        description: "The rule ID to enable",
        required: true,
      },
    },
    execute: async (params: { ruleId: string }) => {
      const workspacePath = await resolveWorkspacePath({});
      const result = await enableRule(workspacePath, params.ruleId);
      return {
        success: true,
        ruleId: params.ruleId,
        enabled: result.enabled,
        disabled: result.disabled,
      };
    },
  });

  // Register rules.disable command
  targetRegistry.registerCommand({
    id: "rules.disable",
    category: CommandCategory.RULES,
    name: "disable",
    description: "Add a rule ID to the disabled list in the project config",
    parameters: {
      ruleId: {
        schema: z.string(),
        description: "The rule ID to disable",
        required: true,
      },
    },
    execute: async (params: { ruleId: string }) => {
      const workspacePath = await resolveWorkspacePath({});
      const result = await disableRule(workspacePath, params.ruleId);
      return {
        success: true,
        ruleId: params.ruleId,
        enabled: result.enabled,
        disabled: result.disabled,
      };
    },
  });

  // Register rules.config command
  targetRegistry.registerCommand({
    id: "rules.config",
    category: CommandCategory.RULES,
    name: "config",
    description: "Show current rule selection state (presets, enabled, disabled)",
    parameters: {},
    execute: async () => {
      const workspacePath = await resolveWorkspacePath({});
      return await getRulesConfig(workspacePath);
    },
  });

  // Register rules.presets command
  targetRegistry.registerCommand({
    id: "rules.presets",
    category: CommandCategory.RULES,
    name: "presets",
    description: "List available rule presets with their rule counts",
    parameters: {},
    execute: async () => {
      return getRulesPresets();
    },
  });
}

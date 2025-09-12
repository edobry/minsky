/**
 * Shared Rules Commands (Migrated to DatabaseCommand)
 *
 * This module contains migrated rules command implementations that use
 * the DatabaseCommand pattern for type-safe persistence access.
 */

import { z } from "zod";
import { DatabaseCommand, DatabaseCommandContext } from "../../../domain/commands/database-command";
import { CommandExecutionResult, CommandParameterMap } from "../command-registry";
import { getErrorMessage } from "../../../errors/index";
import { RuleService, type RuleFormat } from "../../../domain/rules";
import { createRuleTemplateService } from "../../../domain/rules/rule-template-service";
import { type RuleGenerationConfig } from "../../../domain/rules/template-system";
import { resolveWorkspacePath } from "../../../domain/workspace";
import type { EnhancedSearchResult } from "./similarity-command-factory";
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
import { createRuleSimilarityService } from "../../../domain/rules/rule-similarity-service";
import { generateRulesWithConfig } from "../../../domain/rules/rule-template-service";
import type {
  InterfacePreference,
  McpTransportMethod,
} from "../../../domain/rules/template-system";

/**
 * Rule-style result formatter for similarity search results
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
    since: {
      schema: z.string().optional(),
      description:
        "Optional: filter by updated time (YYYY-MM-DD or 7d/24h/30m). Currently not enforced due to missing timestamps.",
      required: false,
    },
    until: {
      schema: z.string().optional(),
      description:
        "Optional: filter by updated time (YYYY-MM-DD or 7d/24h/30m). Currently not enforced due to missing timestamps.",
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
      schema: z.number().int().min(1).optional(),
      description: "Maximum number of rules to process",
      required: false,
    },
    force: {
      schema: z.boolean().optional(),
      description: "Force re-indexing even if embeddings already exist",
      required: false,
    },
  },
  {
    json: CommonParameters.json,
    debug: CommonParameters.debug,
  }
);

/**
 * Rules List Command
 */
export class RulesListCommand extends DatabaseCommand<RulesListParams, any> {
  readonly id = "rules.list";
  readonly category = "RULES";
  readonly name = "list";
  readonly description = "List available rules";
  readonly parameters = rulesListCommandParams;

  async execute(
    params: RulesListParams,
    context: DatabaseCommandContext
  ): Promise<CommandExecutionResult<any>> {
    try {
      const workspacePath = await resolveWorkspacePath({});
      const ruleService = new RuleService(workspacePath);

      // Convert parameters
      const format = params.format as RuleFormat | undefined;

      const rules = await ruleService.listRules({
        format,
        tag: params.tag,
        debug: params.debug,
      });

      // Apply time filtering if provided (when rule timestamps are available)
      let filteredRules = rules;
      try {
        const { parseTime, filterByTimeRange } = require("../../../utils/result-handling/filters");
        const sinceTs = parseTime(params.since);
        const untilTs = parseTime(params.until);
        if (sinceTs !== null || untilTs !== null) {
          // For now, rules don't have timestamps, so we skip filtering
          // but preserve the structure for when timestamps are added
          log.debug("Time filtering requested but rules don't have timestamps yet");
        }
      } catch {
        // ignore filtering errors
      }

      // Transform rules to exclude content field for better usability
      const rulesWithoutContent = filteredRules.map(({ content, ...rule }: any) => rule);

      return {
        success: true,
        rules: rulesWithoutContent,
      };
    } catch (error) {
      log.error("Rules list command failed:", getErrorMessage(error));
      throw error;
    }
  }
}

/**
 * Rules Index Embeddings Command
 */
export class RulesIndexEmbeddingsCommand extends DatabaseCommand<RulesIndexEmbeddingsParams, any> {
  readonly id = "rules.index-embeddings";
  readonly category = "RULES";
  readonly name = "index-embeddings";
  readonly description = "Index rules for similarity search";
  readonly parameters = rulesIndexEmbeddingsParams;

  async execute(
    params: RulesIndexEmbeddingsParams,
    context: DatabaseCommandContext
  ): Promise<CommandExecutionResult<any>> {
    try {
      const config = await getConfiguration();
      const workspacePath = resolveWorkspacePath();

      // Create rule similarity service with injected provider
      const similarityService = await createRuleSimilarityService(workspacePath, {
        persistenceProvider: context.provider,
      });

      // Index the rules
      const result = await similarityService.indexRules({
        limit: params.limit,
        force: params.force || false,
      });

      if (params.json) {
        return {
          success: true,
          data: result,
        };
      }

      const message = `Indexed ${result.indexed} rules (${result.skipped} skipped, ${result.errors} errors)`;

      return {
        success: true,
        data: {
          message,
          ...result,
        },
      };
    } catch (error) {
      log.error("Rules index embeddings command failed:", getErrorMessage(error));
      throw error;
    }
  }
}

/**
 * Rules Search Command
 */
export class RulesSearchCommand extends DatabaseCommand<any, any> {
  readonly id = "rules.search";
  readonly category = "RULES";
  readonly name = "search";
  readonly description = "Search rules by content similarity";
  readonly parameters = {
    query: {
      schema: z.string(),
      description: "Search query",
      required: true,
    },
    limit: {
      schema: z.number().int().min(1).max(100).optional(),
      description: "Maximum number of results",
      required: false,
    },
    format: RulesParameters.format,
    tag: RulesParameters.tag,
    json: CommonParameters.json,
    debug: CommonParameters.debug,
  };

  async execute(
    params: any,
    context: DatabaseCommandContext
  ): Promise<CommandExecutionResult<any>> {
    try {
      const workspacePath = resolveWorkspacePath();

      // Create rule similarity service with injected provider
      const similarityService = await createRuleSimilarityService(workspacePath, {
        persistenceProvider: context.provider,
      });

      const results = await similarityService.searchByText(
        params.query,
        params.limit || 10,
        params.threshold
      );

      if (params.json) {
        return {
          success: true,
          data: { results, count: results.length },
        };
      }

      // Format for human-readable output
      const output = results
        .map((result: any, index: number) => ruleStyleFormatter(result, index, !!params.debug))
        .join("\n\n");

      return {
        success: true,
        data: { output, count: results.length },
      };
    } catch (error) {
      log.error("Rules search command failed:", getErrorMessage(error));
      throw error;
    }
  }
}

/**
 * Parameters for the rules generate command
 */
type RulesGenerateParams = {
  interface?: InterfacePreference;
  rules?: string;
  outputDir?: string;
  dryRun?: boolean;
  overwrite?: boolean;
  format?: "cursor" | "openai";
  preferMcp?: boolean;
  mcpTransport?: McpTransportMethod;
  json?: boolean;
  debug?: boolean;
};

const rulesGenerateCommandParams: CommandParameterMap = composeParams(
  {
    interface: {
      schema: z.enum(["cli", "mcp", "hybrid"]).optional(),
      description: "Interface preference (cli, mcp, or hybrid)",
      required: false,
      defaultValue: "cli",
    },
    rules: {
      schema: z.string().optional(),
      description: "Comma-separated list of specific rule templates to generate",
      required: false,
    },
    outputDir: {
      schema: z.string().optional(),
      description: "Output directory for generated rules",
      required: false,
    },
    dryRun: {
      schema: z.boolean().optional(),
      description: "Show what would be generated without creating files",
      required: false,
      defaultValue: false,
    },
    overwrite: {
      schema: z.boolean().optional(),
      description: "Overwrite existing rule files",
      required: false,
    },
    format: {
      ...RulesParameters.format,
      defaultValue: "cursor",
    },
    preferMcp: {
      schema: z.boolean().optional(),
      description: "In hybrid mode, prefer MCP commands over CLI",
      required: false,
    },
    mcpTransport: {
      schema: z.enum(["stdio", "http"]).optional(),
      description: "MCP transport method (stdio or http)",
      required: false,
    },
  },
  {
    json: CommonParameters.json,
    debug: CommonParameters.debug,
  }
);

/**
 * Rules Generate Command
 */
export class RulesGenerateCommand extends DatabaseCommand<RulesGenerateParams, any> {
  readonly id = "rules.generate";
  readonly category = "RULES";
  readonly name = "generate";
  readonly description = "Generate new rules from templates";
  readonly parameters = rulesGenerateCommandParams;

  async execute(
    params: RulesGenerateParams,
    context: DatabaseCommandContext
  ): Promise<CommandExecutionResult<any>> {
    try {
      const workspacePath = await resolveWorkspacePath({});

      // Build configuration based on interface preference
      let config: RuleGenerationConfig;
      const interfacePreference = params.interface || "cli";

      if (interfacePreference === "mcp") {
        config = {
          targetInterface: "mcp",
          includeCliCommands: false,
          includeMcpTools: true,
          mcpTransport: params.mcpTransport || "stdio",
        };
      } else if (interfacePreference === "hybrid") {
        config = {
          targetInterface: "hybrid",
          includeCliCommands: true,
          includeMcpTools: true,
          preferMcp: params.preferMcp || false,
          mcpTransport: params.mcpTransport || "stdio",
        };
      } else {
        // CLI
        config = {
          targetInterface: "cli",
          includeCliCommands: true,
          includeMcpTools: false,
        };
      }

      // Convert rules parameter to selected rules array
      const selectedRules = params.rules
        ? params.rules.split(",").map((rule) => rule.trim())
        : undefined;

      const result = await generateRulesWithConfig(workspacePath, config, {
        selectedRules,
        outputDir: params.outputDir,
        dryRun: params.dryRun || false,
        overwrite: params.overwrite || false,
        format: (params.format as "cursor" | "openai") || "cursor",
      });

      if (params.json) {
        return {
          success: result.success,
          data: result,
        };
      }

      const generated = result.rules?.length || 0;
      const errors = result.errors?.length || 0;
      const message = `Generated ${generated} rules (${errors} errors)`;

      return {
        success: result.success,
        message,
        generated,
        errors: result.errors,
        rules: result.rules,
      };
    } catch (error) {
      log.error("Rules generate command failed:", getErrorMessage(error));
      throw error;
    }
  }
}

// Export the DatabaseCommand pattern commands
export const rulesCommands = [
  new RulesListCommand(),
  new RulesIndexEmbeddingsCommand(),
  new RulesSearchCommand(),
  new RulesGenerateCommand(),
];

/**
 * BACKWARD COMPATIBILITY: Legacy registration function
 * @deprecated Use rulesCommands array with DatabaseCommand pattern instead
 */
export function registerRulesCommands() {
  log.warn(
    "registerRulesCommands() is deprecated - use rulesCommands array with DatabaseCommand pattern instead"
  );
}

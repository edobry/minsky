/**
 * Tools Commands (Migrated to DatabaseCommand)
 *
 * Migrated tools commands that use DatabaseCommand for type-safe persistence access.
 */

import { z } from "zod";
import { DatabaseCommand, DatabaseCommandContext } from "../../../domain/commands/database-command";
import { CommandExecutionResult, CommandParameterMap } from "../command-registry";
import { createLogger } from "../../../utils/logger";
import { CommonParameters } from "../common-parameters";

const log = createLogger("tools-commands-migrated");

// === Parameter Definitions ===

const toolsSimilarParams: CommandParameterMap = {
  toolId: {
    schema: z.string(),
    help: "Tool ID to find similar tools for",
    required: true,
  },
  limit: {
    schema: z.number().int().positive().default(10),
    help: "Maximum number of results to return",
    required: false,
  },
  threshold: {
    schema: z.number().optional(),
    help: "Optional similarity threshold (higher is more similar)",
    required: false,
  },
  details: {
    schema: z.boolean().default(false),
    help: "Show detailed output including scores and diagnostics",
    required: false,
  },
  json: CommonParameters.json,
};

const toolsSearchParams: CommandParameterMap = {
  query: {
    schema: z.string(),
    help: "Natural language query to search for tools",
    required: true,
  },
  limit: {
    schema: z.number().int().positive().default(10),
    help: "Maximum number of results to return",
    required: false,
  },
  threshold: {
    schema: z.number().optional(),
    help: "Optional similarity threshold (higher is more similar)",
    required: false,
  },
  category: {
    schema: z.string().optional(),
    help: "Filter by tool category (e.g., TASKS, GIT, DEBUG)",
    required: false,
  },
  details: {
    schema: z.boolean().default(false),
    help: "Show detailed output including scores and diagnostics",
    required: false,
  },
  quiet: {
    schema: z.boolean().default(false),
    help: "Suppress progress messages",
    required: false,
  },
  json: CommonParameters.json,
};

const toolsIndexEmbeddingsParams: CommandParameterMap = {
  limit: {
    schema: z.number().int().min(1).optional(),
    help: "Maximum number of tools to process",
    required: false,
  },
  force: {
    schema: z.boolean().optional(),
    help: "Force re-indexing even if embeddings already exist",
    required: false,
  },
  json: CommonParameters.json,
  debug: CommonParameters.debug,
};

// === Type Definitions ===

interface ToolsSimilarParams {
  toolId: string;
  limit?: number;
  threshold?: number;
  details?: boolean;
  json?: boolean;
}

interface ToolsSearchParams {
  query: string;
  limit?: number;
  threshold?: number;
  category?: string;
  details?: boolean;
  quiet?: boolean;
  json?: boolean;
}

interface ToolsIndexEmbeddingsParams {
  limit?: number;
  force?: boolean;
  json?: boolean;
  debug?: boolean;
}

// === Command Implementations ===

/**
 * Tools Similar Command
 */
export class ToolsSimilarCommand extends DatabaseCommand<ToolsSimilarParams, any> {
  readonly id = "tools.similar";
  readonly category = "TOOLS";
  readonly name = "similar";
  readonly description = "Find tools similar to a given tool";
  readonly parameters = toolsSimilarParams;

  async execute(
    params: ToolsSimilarParams,
    context: DatabaseCommandContext
  ): Promise<CommandExecutionResult<any>> {
    try {
      // Import the similarity service factory
      const { createToolSimilarityService } = await import(
        "../../../domain/tools/similarity/tool-similarity-service"
      );

      // Create similarity service
      const similarityService = await createToolSimilarityService();

      const results = await similarityService.similarToTool(
        params.toolId,
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
        .map((result: any, index: number) => {
          const score =
            params.details && result.score !== undefined
              ? ` (score: ${result.score.toFixed(3)})`
              : "";
          const description = result.description ? ` - ${result.description}` : "";
          return `${index + 1}. ${result.id}${score}${description}`;
        })
        .join("\n");

      return {
        success: true,
        data: { output, count: results.length },
      };
    } catch (error) {
      log.error("Tools similar command failed:", error);
      throw error;
    }
  }
}

/**
 * Tools Search Command
 */
export class ToolsSearchCommand extends DatabaseCommand<ToolsSearchParams, any> {
  readonly id = "tools.search";
  readonly category = "TOOLS";
  readonly name = "search";
  readonly description = "Search tools by natural language query";
  readonly parameters = toolsSearchParams;

  async execute(
    params: ToolsSearchParams,
    context: DatabaseCommandContext
  ): Promise<CommandExecutionResult<any>> {
    try {
      // Import the similarity service factory
      const { createToolSimilarityService } = await import(
        "../../../domain/tools/similarity/tool-similarity-service"
      );

      // Create similarity service
      const similarityService = await createToolSimilarityService();

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
        .map((result: any, index: number) => {
          const score =
            params.details && result.score !== undefined
              ? ` (score: ${result.score.toFixed(3)})`
              : "";
          const description = result.description ? ` - ${result.description}` : "";
          const category = result.category ? ` [${result.category}]` : "";
          return `${index + 1}. ${result.id}${category}${score}${description}`;
        })
        .join("\n");

      return {
        success: true,
        data: { output, count: results.length },
      };
    } catch (error) {
      log.error("Tools search command failed:", error);
      throw error;
    }
  }
}

/**
 * Tools Index Embeddings Command
 */
export class ToolsIndexEmbeddingsCommand extends DatabaseCommand<ToolsIndexEmbeddingsParams, any> {
  readonly id = "tools.index-embeddings";
  readonly category = "TOOLS";
  readonly name = "index-embeddings";
  readonly description = "Index tools for similarity search";
  readonly parameters = toolsIndexEmbeddingsParams;

  async execute(
    params: ToolsIndexEmbeddingsParams,
    context: DatabaseCommandContext
  ): Promise<CommandExecutionResult<any>> {
    try {
      // Import the tool embedding service factory
      const { createToolEmbeddingService } = await import(
        "../../../domain/tools/tool-embedding-service"
      );

      // Create embedding service
      const embeddingService = await createToolEmbeddingService();

      // Index all tools
      const result = await embeddingService.indexAllTools();

      if (params.json) {
        return {
          success: true,
          data: {
            indexed: result.indexed,
            skipped: result.skipped,
            errors: result.errors,
          },
        };
      }

      const message = `Indexed ${result.indexed} tools (${result.skipped} skipped, ${result.errors.length} errors)`;

      return {
        success: true,
        data: {
          message,
          indexed: result.indexed,
          skipped: result.skipped,
          errors: result.errors,
        },
      };
    } catch (error) {
      log.error("Tools index embeddings command failed:", error);
      throw error;
    }
  }
}

// Export the DatabaseCommand pattern commands
export const toolsCommands = [
  new ToolsSimilarCommand(),
  new ToolsSearchCommand(),
  new ToolsIndexEmbeddingsCommand(),
];

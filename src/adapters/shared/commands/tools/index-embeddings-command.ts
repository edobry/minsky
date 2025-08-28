/**
 * Tools Index Embeddings Command
 *
 * Command for generating and storing embeddings for all tools.
 * Follows patterns from tasks and rules index-embeddings commands.
 */
import { CommandExecutionContext } from "../../command-registry";
import { z } from "zod";
import { composeParams, CommonParameters } from "../../common-parameters";
import type { CommandParameterMap } from "../../schema-bridge";

export interface ToolsIndexEmbeddingsParams {
  limit?: number;
  force?: boolean;
  json?: boolean;
  debug?: boolean;
}

export const toolsIndexEmbeddingsParams: CommandParameterMap = composeParams(
  {
    limit: {
      schema: z.number().int().positive().optional(),
      description: "Limit number of tools to index (for debugging)",
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
 * Tools Index Embeddings Command Implementation
 */
export class ToolsIndexEmbeddingsCommand {
  readonly id = "tools.index-embeddings";
  readonly name = "index-embeddings";
  readonly description = "Generate and store embeddings for tools (tool_embeddings)";
  readonly parameters = toolsIndexEmbeddingsParams;

  async execute(params: ToolsIndexEmbeddingsParams, ctx?: CommandExecutionContext) {
    try {
      const { createToolEmbeddingService } = await import(
        "../../../../domain/tools/tool-embedding-service"
      );
      const { createLogger } = await import("../../../../utils/logger");

      const log = createLogger("tools:index-embeddings");
      const service = await createToolEmbeddingService();

      // If limit is specified, we'll need to get all tools and slice
      // For now, index all tools (following the pattern)
      const start = Date.now();

      if (!(params.json || ctx?.format === "json")) {
        log.cli("Indexing embeddings for all tools...");
      }

      // Index all tools using the service
      const result = await service.indexAllTools();
      const elapsed = Date.now() - start;

      if (params.json || ctx?.format === "json") {
        return {
          success: true,
          indexed: result.indexed,
          skipped: result.skipped,
          errors: result.errors,
          totalTools: result.indexed + result.skipped + result.errors.length,
          elapsedMs: elapsed,
        };
      }

      // Human-friendly output
      log.cli(`\nTool embeddings indexing complete:`);
      log.cli(`  • Indexed: ${result.indexed} tools`);
      log.cli(`  • Skipped: ${result.skipped} tools (up-to-date)`);
      if (result.errors.length > 0) {
        log.cli(`  • Errors: ${result.errors.length} tools`);
        for (const error of result.errors) {
          log.error(`    ${error}`);
        }
      }
      log.cli(`  • Elapsed: ${elapsed}ms`);

      return {
        success: result.errors.length === 0,
        indexed: result.indexed,
        skipped: result.skipped,
        errors: result.errors,
      };
    } catch (error) {
      const { createLogger } = await import("../../../../utils/logger");
      const log = createLogger("tools:index-embeddings");

      const errorMsg = `Failed to index tool embeddings: ${
        error instanceof Error ? error.message : String(error)
      }`;

      if (params.json || ctx?.format === "json") {
        return {
          success: false,
          error: errorMsg,
        };
      }

      log.error(errorMsg);
      throw error;
    }
  }
}

/**
 * Factory function for creating the command instance
 */
export function createToolsIndexEmbeddingsCommand(): ToolsIndexEmbeddingsCommand {
  return new ToolsIndexEmbeddingsCommand();
}

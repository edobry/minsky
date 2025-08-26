/**
 * Generic Similarity Search Command Factory
 *
 * Provides a reusable pattern for creating similarity search commands
 * with customizable result formatting and enhancement.
 *
 * @example
 * ```typescript
 * // In your domain-specific module (e.g., rules-search-command.ts):
 * import { createSimilaritySearchCommand } from "../similarity-command-factory";
 * import { ruleStyleFormatter } from "./rules-search-formatter";
 *
 * export const rulesSearchCommand = createSimilaritySearchCommand({
 *   commandId: "rules.search",
 *   name: "search",
 *   description: "Search for rules...",
 *   entityName: "rules",
 *   createService: () => createRuleSimilarityService(),
 *   searchMethod: (service, query, limit, threshold) => service.searchByText(query, limit, threshold),
 *   enhanceResults: enhanceRulesResults, // Your custom enhancement logic
 *   formatResult: ruleStyleFormatter,    // Your custom formatter
 * });
 * ```
 */

import type { CommandExecutionContext } from "../types";
import { log } from "../../../utils/logger";
import { getErrorMessage } from "../../../errors/utils";

/**
 * Base interface for similarity search results
 */
export interface SimilaritySearchResult {
  id: string;
  score?: number;
}

/**
 * Enhanced search result with additional metadata
 */
export interface EnhancedSearchResult extends SimilaritySearchResult {
  name?: string;
  description?: string;
  [key: string]: any; // Allow additional fields
}

/**
 * Configuration for creating a similarity search command
 */
export interface SimilarityCommandConfig<TService, TResult extends SimilaritySearchResult> {
  /** Command identifier (e.g., "tasks.search", "rules.search") */
  commandId: string;

  /** Command name (e.g., "search") */
  name: string;

  /** Command description */
  description: string;

  /** Entity name for progress messages (e.g., "tasks", "rules") */
  entityName: string;

  /** Factory function to create the search service */
  createService: () => Promise<TService>;

  /** Method to perform the search on the service */
  searchMethod: (
    service: TService,
    query: string,
    limit: number,
    threshold?: number
  ) => Promise<TResult[]>;

  /** Optional result enhancement function */
  enhanceResults?: (results: TResult[], workspacePath: string) => Promise<EnhancedSearchResult[]>;

  /**
   * Custom result formatter for CLI output
   * If not provided, uses defaultSimilarityFormatter
   * Each consuming module should provide its own formatter
   */
  formatResult?: (result: EnhancedSearchResult, index: number, showScore: boolean) => string;
}

/**
 * Shared parameters for similarity search commands
 */
export const similaritySearchParams = {
  query: {
    schema: { type: "string" as const },
    description: "Natural language query",
    required: true,
  },
  limit: {
    schema: { type: "number" as const, default: 10 },
    description: "Max number of results",
    required: false,
  },
  threshold: {
    schema: { type: "number" as const },
    description: "Optional distance threshold (lower is closer)",
    required: false,
  },
  details: {
    schema: { type: "boolean" as const, default: false },
    description: "Show detailed diagnostic information",
    required: false,
  },
  quiet: {
    schema: { type: "boolean" as const, default: false },
    description: "Suppress progress messages",
    required: false,
  },
  json: {
    schema: { type: "boolean" as const, default: false },
    description: "Output results in JSON format",
    required: false,
  },
};

/**
 * Create a similarity search command with the given configuration
 */
export function createSimilaritySearchCommand<TService, TResult extends SimilaritySearchResult>(
  config: SimilarityCommandConfig<TService, TResult>
) {
  return {
    id: config.commandId,
    name: config.name,
    description: config.description,
    parameters: similaritySearchParams,

    execute: async (params: any, ctx?: CommandExecutionContext) => {
      try {
        const query = params.query as string;
        const limit = params.limit ?? 10;
        const threshold = params.threshold;
        const quiet = Boolean(params.quiet);
        const json = Boolean(params.json) || ctx?.format === "json";

        // Progress message
        if (!quiet && !json && query) {
          log.cliWarn(`Searching for ${config.entityName} matching: "${query}" ...`);
        }

        // Create service and perform search
        const service = await config.createService();
        const results = await config.searchMethod(service, query, limit, threshold);

        // Optional diagnostics in details mode
        if (params.details) {
          try {
            const { getConfiguration } = await import("../../../domain/configuration");
            const cfg = await getConfiguration();
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

        // Enhance results if enhancer provided
        let enhancedResults: EnhancedSearchResult[];
        if (config.enhanceResults) {
          // Need workspace path for enhancement
          const { resolveWorkspacePath } = await import("../../../domain/workspace");
          const workspacePath = await resolveWorkspacePath({});
          enhancedResults = await config.enhanceResults(results, workspacePath);
        } else {
          // Use results as-is, ensuring they have the required shape
          enhancedResults = results.map((r) => ({
            ...r,
            name: r.id,
            description: "",
          }));
        }

        return {
          success: true,
          count: enhancedResults.length,
          results: enhancedResults,
          details: params.details,
          // Note: Actual CLI formatting is handled by DefaultCommandResultFormatter
          // which uses the existing command-specific formatters in result-formatter.ts
          // The formatResult config option is available for future extensibility
        };
      } catch (error) {
        log.error(`Failed to search ${config.entityName}`, {
          error: getErrorMessage(error as any),
          query: params.query,
        });
        throw error;
      }
    },
  };
}

/**
 * Default result formatter for similarity search results
 * Simple format: "1. name - description"
 */
export function defaultSimilarityFormatter(
  result: EnhancedSearchResult,
  index: number,
  showScore: boolean
): string {
  const name = result.name || result.id;
  const desc = result.description ? ` - ${result.description}` : "";
  const scorePart =
    showScore && result.score !== undefined ? `\nScore: ${result.score.toFixed(3)}` : "";
  return `${index + 1}. ${name}${desc}${scorePart}`;
}

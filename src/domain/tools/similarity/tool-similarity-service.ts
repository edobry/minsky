import {
  createToolSimilarityCore,
  type ToolSimilarityCoreOptions,
} from "./create-tool-similarity-core";
import {
  sharedCommandRegistry,
  type SharedCommand,
} from "../../../adapters/shared/command-registry";
import { createLogger } from "../../../utils/logger";
import type { SimilarityItem } from "../../similarity/types";

const log = createLogger("tool-similarity-service");

export interface SearchResult {
  id: string;
  score: number;
}

export interface ToolSimilarityServiceConfig {
  threshold?: number; // maximum distance for inclusion (backend-specific semantics)
}

export interface ToolSearchRequest {
  query: string;
  limit?: number;
  threshold?: number;
  categories?: string[]; // CommandCategory enum values
}

export interface RelevantTool {
  toolId: string;
  relevanceScore: number;
  tool: SharedCommand;
  reason?: string;
}

/**
 * ToolSimilarityService: embedding-based tool retrieval
 * Follows patterns from TaskSimilarityService and RuleSimilarityService
 */
export class ToolSimilarityService {
  constructor(private readonly config: ToolSimilarityServiceConfig = {}) {}

  /**
   * Search tools by natural language query using embeddings and fallback mechanisms
   */
  async searchByText(query: string, limit = 10, threshold?: number): Promise<SearchResult[]> {
    const core = await createToolSimilarityCore();
    const items: SimilarityItem[] = await core.search({ queryText: query, limit });

    return items.map((i) => ({ id: i.id, score: i.score }) as SearchResult);
  }

  /**
   * Find relevant tools based on user query with rich context
   * Primary interface for context-aware tool filtering
   */
  async findRelevantTools(request: ToolSearchRequest): Promise<RelevantTool[]> {
    const core = await createToolSimilarityCore();
    const items: SimilarityItem[] = await core.search({
      queryText: request.query,
      limit: request.limit || 20,
    });

    const results: RelevantTool[] = [];
    for (const item of items) {
      const tool = sharedCommandRegistry.getCommand(item.id);
      if (!tool) {
        continue; // Skip if tool not found in registry
      }

      // Filter by category if specified
      if (request.categories && request.categories.length > 0) {
        if (!request.categories.includes(tool.category)) {
          continue;
        }
      }

      // Apply threshold if specified
      if (request.threshold && item.score < request.threshold) {
        continue;
      }

      results.push({
        toolId: item.id,
        relevanceScore: item.score,
        tool,
        reason: this.generateReasonForTool(tool, request.query, item.score),
      });
    }

    log.debug(`Found ${results.length} relevant tools for query: "${request.query}"`);
    return results;
  }

  /**
   * Get the backend that was last used for similarity search
   * Useful for debugging and understanding which backend was used
   */
  async getLastUsedBackend(): Promise<string | null> {
    const core = await createToolSimilarityCore();
    return core.getLastUsedBackend();
  }

  /**
   * Generate a human-readable reason for why a tool was selected
   */
  private generateReasonForTool(tool: SharedCommand, query: string, score: number): string {
    // Simple heuristic for generating explanations
    const queryWords = query.toLowerCase().split(/\s+/);
    const toolWords = [tool.name, tool.description, tool.category.toLowerCase()]
      .join(" ")
      .toLowerCase();

    const matchedWords = queryWords.filter((word) => toolWords.includes(word));

    if (matchedWords.length > 0) {
      return `Matches keywords: ${matchedWords.join(", ")}`;
    }

    if (score > 0.8) {
      return "High semantic similarity";
    } else if (score > 0.5) {
      return "Moderate semantic similarity";
    } else {
      return "Lexical fallback match";
    }
  }
}

/**
 * Create a configured ToolSimilarityService instance
 */
export async function createToolSimilarityService(
  config: ToolSimilarityServiceConfig = {}
): Promise<ToolSimilarityService> {
  return new ToolSimilarityService(config);
}

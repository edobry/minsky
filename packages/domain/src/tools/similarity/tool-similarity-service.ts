import { injectable } from "tsyringe";
import { createToolSimilarityCore } from "./create-tool-similarity-core";
import {
  sharedCommandRegistry,
  type SharedCommand,
} from "../../../../../src/adapters/shared/command-registry";
import { createLogger } from "@minsky/shared/logger";
import type { PersistenceProvider } from "../../persistence/types";

const log = createLogger();

export interface SearchResult {
  id: string;
  score: number;
}

export interface ToolSimilarityServiceConfig {
  /** Minimum similarity for inclusion, higher is more similar (mt#4805). */
  threshold?: number;
}

export interface ToolSearchRequest {
  query: string;
  limit?: number;
  /**
   * Minimum similarity for inclusion — higher is more similar (mt#4805).
   *
   * This was ALWAYS the documented contract: the `tools_search` / `tools_similar`
   * commands describe it as "Optional similarity threshold (higher is more
   * similar)", and `findRelevantTools`' filter was written to match. What was
   * wrong was the number it compared against — `SimilarityItem.score` carried the
   * vector store's raw L2 distance, so the filter's meaning was inverted against
   * the contract it implemented. The fix converts the score, not this predicate.
   */
  threshold?: number;
  categories?: string[]; // CommandCategory enum values
}

export interface RelevantTool {
  toolId: string;
  /**
   * Cosine similarity in [0, 1] — higher is more similar (mt#4805).
   *
   * The name was accurate and the value was not: this held
   * `SimilarityItem.score`, which the embeddings backend passed through as an L2
   * DISTANCE, so `tools_search` emitted an ASCENDING number to every MCP consumer
   * while ordering the rows best-first. Measured live before the fix, for the
   * query "create a new task with a spec": 0.830 for the best match rising to
   * 1.086 for the tenth. Same defect mt#4787 fixed on the memory surface, on this
   * one.
   */
  relevanceScore: number;
  tool: SharedCommand;
  reason?: string;
}

/**
 * ToolSimilarityService: embedding-based tool retrieval
 * Follows patterns from TaskSimilarityService and RuleSimilarityService
 */
@injectable()
export class ToolSimilarityService {
  constructor(
    private readonly persistenceProvider: PersistenceProvider,
    private readonly config: ToolSimilarityServiceConfig = {}
  ) {}

  /**
   * Find tools similar to a given tool using embeddings
   */
  async similarToTool(toolId: string, limit = 10, threshold?: number): Promise<SearchResult[]> {
    const tool = sharedCommandRegistry.getCommand(toolId);
    if (!tool) {
      log.debug(`Tool not found: ${toolId}`);
      return [];
    }

    // Create search content from tool metadata
    const toolContent = [
      tool.name,
      tool.description,
      tool.category,
      // Add parameter descriptions if available
      Object.values(tool.parameters || {})
        .map((p: { help?: string }) => p.help || "")
        .filter(Boolean)
        .join(" "),
    ]
      .filter(Boolean)
      .join(" ");

    const core = await createToolSimilarityCore({ persistenceProvider: this.persistenceProvider });
    const response = await core.search({ queryText: toolContent, limit });

    // Filter out the original tool from results
    return response.items
      .filter((i) => i.id !== toolId)
      .map((i) => ({ id: i.id, score: i.score }) as SearchResult);
  }

  /**
   * Search tools by natural language query using embeddings and fallback mechanisms
   */
  async searchByText(query: string, limit = 10, threshold?: number): Promise<SearchResult[]> {
    const core = await createToolSimilarityCore({ persistenceProvider: this.persistenceProvider });
    const response = await core.search({ queryText: query, limit });

    return response.items.map((i) => ({ id: i.id, score: i.score }) as SearchResult);
  }

  /**
   * Find relevant tools based on user query with rich context
   * Primary interface for context-aware tool filtering
   */
  async findRelevantTools(request: ToolSearchRequest): Promise<RelevantTool[]> {
    const core = await createToolSimilarityCore({ persistenceProvider: this.persistenceProvider });
    const response = await core.search({
      queryText: request.query,
      limit: request.limit || 20,
    });
    const items = response.items;

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

      // Apply threshold if specified. `item.score` is a similarity (higher is
      // more similar) for every backend as of mt#4805, so this predicate — which
      // always matched the parameter's documented contract — is now correct
      // against the embeddings backend too, not just the lexical fallback it
      // happened to work for.
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
    const core = await createToolSimilarityCore({ persistenceProvider: this.persistenceProvider });
    return core.getLastUsedBackend();
  }

  /**
   * Generate a human-readable reason for why a tool was selected.
   *
   * `score` is a similarity — higher is more similar — as of mt#4805. It used to
   * be the vector store's L2 DISTANCE, which made the bands below inert in the
   * saturated direction rather than merely mis-tuned: real distances for a
   * natural-language query run roughly 0.83 to 1.09 (measured 2026-08-31), so
   * `score > 0.8` was true for EVERY result and every tool was labelled "High
   * semantic similarity", including the worst match in the set. A label that is
   * constant carries no information, and nothing about the output looked wrong.
   *
   * The band VALUES are deliberately unchanged. They were never derived from a
   * measured distribution, and re-deriving them from the one query measured here
   * would be fitting a threshold to a single observation — the failure mem#1161
   * §3 records. What changed is that they are now applied to the quantity they
   * were written for, so they discriminate again: the same query's converted
   * similarities run 0.66 down to 0.41, which lands in "Moderate" and "Lexical
   * fallback". Tuning them against a real query distribution is a separate
   * question, and belongs with mt#450's normalization/display work.
   *
   * Note also that the keyword branch below short-circuits: the bands are only
   * reached when no query word appears in the tool's own text.
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
  config: ToolSimilarityServiceConfig = {},
  persistenceProvider: PersistenceProvider
): Promise<ToolSimilarityService> {
  return new ToolSimilarityService(persistenceProvider, config);
}

import type { Task } from "../tasks";
import { log } from "../../utils/logger";
import type { EmbeddingService } from "../ai/embeddings/types";
import type { VectorStorage, SearchResult } from "../storage/vector/types";
import { createHash } from "crypto";
import { SimilaritySearchService } from "../similarity/similarity-search-service";
import { EmbeddingsSimilarityBackend } from "../similarity/backends/embeddings-backend";
import { LexicalSimilarityBackend } from "../similarity/backends/lexical-backend";
import { first } from "../../utils/array-safety";

export interface TaskSimilarityServiceConfig {
  similarityThreshold?: number;
  vectorLimit?: number;
  model?: string;
  dimension?: number;
}

export interface TaskSearchResponse {
  results: SearchResult[];
  backend: string;
  degraded: boolean;
  degradedReason?: string;
}

export class TaskSimilarityService {
  private searchService: SimilaritySearchService | null = null;

  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly vectorStorage: VectorStorage,
    private readonly findTaskById: (id: string) => Promise<Task | null>,
    private readonly searchTasks: (query: { text?: string }) => Promise<Task[]>,
    private readonly getTaskSpecContent: (
      id: string
    ) => Promise<{ content: string; specPath: string; task: Task }>,
    private readonly config: TaskSimilarityServiceConfig = {}
  ) {}

  /** Build or return the cached SimilaritySearchService from injected deps */
  private getSearchService(): SimilaritySearchService {
    if (!this.searchService) {
      const embeddingsBackend = new EmbeddingsSimilarityBackend(
        this.embeddingService,
        this.vectorStorage
      );
      const lexicalBackend = new LexicalSimilarityBackend({
        getById: this.findTaskById,
        listCandidateIds: async () => (await this.searchTasks({})).map((t) => t.id),
        getContent: async (id: string) => (await this.getTaskSpecContent(id)).content,
      });
      this.searchService = new SimilaritySearchService([embeddingsBackend, lexicalBackend]);
    }
    return this.searchService;
  }

  /** Expose service configuration for diagnostics */
  getConfig(): TaskSimilarityServiceConfig {
    return this.config;
  }

  async similarToTask(taskId: string, limit = 10, threshold?: number): Promise<TaskSearchResponse> {
    const task = await this.findTaskById(taskId);
    if (!task) {
      return { results: [], backend: "none", degraded: false };
    }
    const content = await this.extractTaskContent(task);
    const response = await this.getSearchService().search({ queryText: content, limit });
    return {
      results: response.items.map((i) => ({
        id: i.id,
        score: i.score,
        metadata: i.metadata,
      })),
      backend: response.backend,
      degraded: response.degraded,
      degradedReason: response.degradedReason,
    };
  }

  async searchByText(
    query: string,
    limit = 10,
    threshold?: number,
    filters?: Record<string, unknown>
  ): Promise<TaskSearchResponse> {
    const response = await this.getSearchService().search({ queryText: query, limit, filters });
    return {
      results: response.items.map((i) => ({
        id: i.id,
        score: i.score,
        metadata: i.metadata,
      })),
      backend: response.backend,
      degraded: response.degraded,
      degradedReason: response.degradedReason,
    };
  }

  async searchSimilarTasks(
    searchTerms: string[],
    excludeTaskIds: string[] = [],
    limit = 10,
    threshold?: number
  ): Promise<TaskSearchResponse> {
    if (searchTerms.length === 0) {
      return { results: [], backend: "none", degraded: false };
    }

    // Create a natural language query from the search terms
    const query = this.constructSearchQuery(searchTerms);
    const response = await this.searchByText(query, limit * 2, threshold);

    // Filter out excluded task IDs
    const filtered = response.results
      .filter((result) => !excludeTaskIds.includes(result.id))
      .slice(0, limit);

    return {
      results: filtered,
      backend: response.backend,
      degraded: response.degraded,
      degradedReason: response.degradedReason,
    };
  }

  /**
   * Construct natural search query from terms
   * This logic will move to the generic similarity service in md#447
   */
  private constructSearchQuery(terms: string[]): string {
    // Create a natural language query that works well with embeddings
    const uniqueTerms = Array.from(new Set(terms.map((t) => t.toLowerCase())));

    if (uniqueTerms.length === 1) {
      return first(uniqueTerms, "search query terms");
    }

    // For multiple terms, create a coherent query
    return `Find tasks related to: ${uniqueTerms.join(", ")}`;
  }

  async indexTask(taskId: string): Promise<boolean> {
    const task = await this.findTaskById(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Get the full task content (title + spec content)
    let content = await this.extractTaskContent(task);
    const contentHash = createHash("sha256").update(content).digest("hex");

    // Skip if up-to-date
    try {
      if (typeof this.vectorStorage.getMetadata === "function") {
        const meta = await this.vectorStorage.getMetadata!(taskId);
        const storedHash = meta?.content_hash || meta?.contentHash;
        const storedModel = meta?.model;
        const currentModel = this.config.model;
        if (
          storedHash &&
          storedHash === contentHash &&
          (!storedModel || storedModel === currentModel)
        ) {
          try {
            log.debug(`[index] skip up-to-date ${taskId}`);
          } catch {
            void 0; // ignore debug logging errors
          }
          return false;
        }
      }
    } catch {
      // ignore metadata read errors
    }
    // Apply model-aware token cap if configured
    try {
      const { getConfiguration } = await import("../configuration");
      const cfg = (await getConfiguration()) as Record<string, unknown>;
      const embeddings = cfg?.["embeddings"] as Record<string, unknown> | undefined;
      const model =
        this.config.model || (embeddings?.["model"] as string) || "text-embedding-3-small";
      const ai = cfg?.["ai"] as Record<string, unknown> | undefined;
      const provider =
        (embeddings?.["provider"] as string) || (ai?.["defaultProvider"] as string) || "openai";
      const embeddingModels = embeddings?.["models"] as
        | Record<string, Record<string, unknown>>
        | undefined;
      const caps = (embeddingModels && embeddingModels[model]) || {};
      // Built-in defaults by model pattern; can be overridden by config
      const defaultMaxByModel: Record<string, number> = {
        "text-embedding-3-small": 8192,
        "text-embedding-3-large": 8192,
      };
      const maxTokens: number | undefined =
        typeof caps.maxTokens === "number"
          ? caps.maxTokens
          : defaultMaxByModel[model] || (model.includes("embedding") ? 8192 : undefined);
      const buffer: number = typeof caps.buffer === "number" ? caps.buffer : 192;
      if (typeof maxTokens === "number" && maxTokens > 0) {
        const effective = Math.max(1, maxTokens - buffer);
        const { defaultTokenizerService } = await import("../ai/tokenizer-service");
        const tokens = await defaultTokenizerService.tokenize(content, model, provider);
        if (tokens.length > effective) {
          const trimmed = tokens.slice(0, effective);
          content = await defaultTokenizerService.detokenize(trimmed, model, provider);
        }
      }
    } catch {
      // If tokenization or config fails, apply a conservative char-based trim fallback
      try {
        const { getConfiguration } = await import("../configuration");
        const cfg = (await getConfiguration()) as Record<string, unknown>;
        const embeddingsCfg = cfg?.["embeddings"] as Record<string, unknown> | undefined;
        const model =
          this.config.model || (embeddingsCfg?.["model"] as string) || "text-embedding-3-small";
        const embeddingModelsCfg = embeddingsCfg?.["models"] as
          | Record<string, Record<string, unknown>>
          | undefined;
        const caps = (embeddingModelsCfg && embeddingModelsCfg[model]) || {};
        const defaultMaxByModel: Record<string, number> = {
          "text-embedding-3-small": 8192,
          "text-embedding-3-large": 8192,
        };
        const maxTokens: number | undefined =
          typeof caps.maxTokens === "number"
            ? caps.maxTokens
            : defaultMaxByModel[model] || (model.includes("embedding") ? 8192 : undefined);
        const buffer: number = typeof caps.buffer === "number" ? caps.buffer : 192;
        if (typeof maxTokens === "number" && maxTokens > 0) {
          const effective = Math.max(1, maxTokens - buffer);
          // Heuristic: ~4 chars per token
          const maxChars = effective * 4;
          if (content.length > maxChars) {
            content = content.slice(0, maxChars);
          }
        }
      } catch {
        // ignore and keep original content
      }
    }
    const vector = await this.embeddingService.generateEmbedding(content);
    const metadata: Record<string, unknown> = {
      taskId,
      model: this.config.model,
      dimension: this.config.dimension,
      contentHash,
      updatedAt: new Date().toISOString(),
    };

    await this.vectorStorage.store(taskId, vector, metadata);
    return true;
  }

  /**
   * Extract content for embedding generation
   * Simple approach: title + full spec content (as requested)
   * This prepares for the generic similarity service in md#447
   */
  private async extractTaskContent(task: Task): Promise<string> {
    const parts: string[] = [];

    // Always include the task title
    if (task.title) {
      parts.push(task.title);
    }

    try {
      // Get the full spec content for embedding
      const specData = await this.getTaskSpecContent(task.id);
      if (specData.content) {
        parts.push(specData.content);
      }
    } catch (error) {
      // If we can't get spec content, fall back to basic task info
      log.debug(
        `Failed to get spec content for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`
      );
      if (task.description) {
        parts.push(task.description);
      }
    }

    return parts.join("\n\n");
  }
}

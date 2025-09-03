import type { Task } from "../tasks";
import { log } from "../../utils/logger";
import type { EmbeddingService } from "../ai/embeddings/types";
import type { VectorStorage, SearchResult } from "../storage/vector/types";
import type { PersistenceProvider } from "../persistence/types";
import { createHash } from "crypto";
import { createTaskSimilarityCore } from "../similarity/create-task-similarity-core";

export interface TaskSimilarityServiceConfig {
  similarityThreshold?: number;
  vectorLimit?: number;
  model?: string;
  dimension?: number;
}

export class TaskSimilarityService {
  private vectorStorage: VectorStorage | null = null;
  
  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly persistence: PersistenceProvider,
    private readonly findTaskById: (id: string) => Promise<Task | null>,
    private readonly searchTasks: (query: { text?: string }) => Promise<Task[]>,
    private readonly getTaskSpecContent: (
      id: string
    ) => Promise<{ content: string; specPath: string; task: any }>,
    private readonly config: TaskSimilarityServiceConfig = {}
  ) {}

  /**
   * @deprecated Use constructor with PersistenceProvider instead
   */
  static createWithVectorStorage(
    embeddingService: EmbeddingService,
    vectorStorage: VectorStorage,
    findTaskById: (id: string) => Promise<Task | null>,
    searchTasks: (query: { text?: string }) => Promise<Task[]>,
    getTaskSpecContent: (
      id: string
    ) => Promise<{ content: string; specPath: string; task: any }>,
    config: TaskSimilarityServiceConfig = {}
  ): TaskSimilarityService {
    // Create a minimal persistence provider wrapper for backward compatibility
    const mockPersistence = {
      capabilities: { vectorStorage: true, sql: true, transactions: true, jsonb: true, migrations: true },
      getVectorStorage: async () => vectorStorage,
    } as PersistenceProvider;
    
    const service = new TaskSimilarityService(
      embeddingService,
      mockPersistence,
      findTaskById,
      searchTasks,
      getTaskSpecContent,
      config
    );
    service.vectorStorage = vectorStorage;
    return service;
  }

  async initialize(): Promise<void> {
    if (!this.persistence.capabilities.vectorStorage) {
      throw new Error('Vector storage not supported by current backend');
    }
    
    const dimension = this.config.dimension || 1536;
    this.vectorStorage = await this.persistence.getVectorStorage?.(dimension);
    
    if (!this.vectorStorage) {
      throw new Error('Failed to initialize vector storage from persistence provider');
    }
  }

  async similarToTask(taskId: string, limit = 10, threshold?: number): Promise<SearchResult[]> {
    if (!this.vectorStorage) {
      await this.initialize();
    }
    
    // Delegate to generic core; embeddings backend will be first if available
    const core = await createTaskSimilarityCore({
      getById: this.findTaskById,
      listCandidateIds: async () => (await this.searchTasks({})).map((t) => t.id),
      getContent: async (id: string) => (await this.getTaskSpecContent(id)).content,
    });
    const task = await this.findTaskById(taskId);
    if (!task) return [];
    const content = await this.extractTaskContent(task);
    const items = await core.search({ queryText: content, limit });
    return items.map((i) => ({ id: i.id, score: i.score, metadata: i.metadata }));
  }

  async searchByText(
    query: string,
    limit = 10,
    threshold?: number,
    filters?: Record<string, any>
  ): Promise<SearchResult[]> {
    if (!this.vectorStorage) {
      await this.initialize();
    }
    
    const core = await createTaskSimilarityCore({
      getById: this.findTaskById,
      listCandidateIds: async () => (await this.searchTasks({})).map((t) => t.id),
      getContent: async (id: string) => (await this.getTaskSpecContent(id)).content,
    });
    const items = await core.search({ queryText: query, limit, filters });
    return items.map((i) => ({ id: i.id, score: i.score, metadata: i.metadata }));
  }

  async searchSimilarTasks(
    searchTerms: string[],
    excludeTaskIds: string[] = [],
    limit = 10,
    threshold?: number
  ): Promise<SearchResult[]> {
    if (searchTerms.length === 0) return [];

    // Create a natural language query from the search terms
    const query = this.constructSearchQuery(searchTerms);
    const results = await this.searchByText(query, limit * 2, threshold); // Get more to filter

    // Filter out excluded task IDs
    return results.filter((result) => !excludeTaskIds.includes(result.id)).slice(0, limit);
  }

  /**
   * Construct natural search query from terms
   * This logic will move to the generic similarity service in md#447
   */
  private constructSearchQuery(terms: string[]): string {
    // Create a natural language query that works well with embeddings
    const uniqueTerms = Array.from(new Set(terms.map((t) => t.toLowerCase())));

    if (uniqueTerms.length === 1) {
      return uniqueTerms[0];
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
      if (typeof (this.vectorStorage as any).getMetadata === "function") {
        const meta = await (this.vectorStorage as any).getMetadata(taskId);
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
      const cfg: any = await getConfiguration();
      const model = this.config.model || cfg?.embeddings?.model || "text-embedding-3-small";
      const provider = cfg?.embeddings?.provider || cfg?.ai?.defaultProvider || "openai";
      const caps = (cfg?.embeddings?.models && cfg.embeddings.models[model]) || {};
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
        const cfg: any = await getConfiguration();
        const model = this.config.model || cfg?.embeddings?.model || "text-embedding-3-small";
        const caps = (cfg?.embeddings?.models && cfg.embeddings.models[model]) || {};
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
    const metadata: Record<string, any> = {
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
      log.debug(`Failed to get spec content for task ${task.id}:`, error);
      if ((task as any).description) {
        parts.push((task as any).description);
      }
    }

    return parts.join("\n\n");
  }
}

import type { Task } from "../tasks";
import { log } from "../../utils/logger";
import type { EmbeddingService } from "../ai/embeddings/types";
import type { VectorStorage, SearchResult } from "../storage/vector/types";
import { createHash } from "crypto";

export interface TaskSimilarityServiceConfig {
  similarityThreshold?: number;
  vectorLimit?: number;
  model?: string;
  dimension?: number;
}

export class TaskSimilarityService {
  constructor(
    private readonly embeddingService: EmbeddingService,
    private readonly vectorStorage: VectorStorage,
    private readonly findTaskById: (id: string) => Promise<Task | null>,
    private readonly searchTasks: (query: { text?: string }) => Promise<Task[]>,
    private readonly getTaskSpecContent: (
      id: string
    ) => Promise<{ content: string; specPath: string; task: any }>,
    private readonly config: TaskSimilarityServiceConfig = {}
  ) {}

  async similarToTask(taskId: string, limit = 10, threshold?: number): Promise<SearchResult[]> {
    const task = await this.findTaskById(taskId);
    if (!task) return [];
    const content = await this.extractTaskContent(task);
    const vector = await this.embeddingService.generateEmbedding(content);
    const effectiveThreshold =
      threshold ?? this.config.similarityThreshold ?? Number.POSITIVE_INFINITY;
    return this.vectorStorage.search(vector, limit, effectiveThreshold);
  }

  async searchByText(query: string, limit = 10, threshold?: number): Promise<SearchResult[]> {
    const vector = await this.embeddingService.generateEmbedding(query);
    // Debug: embedding stats (length only)
    try {
      log.debug("[tasks.search] Embedding generated", {
        length: Array.isArray(vector) ? vector.length : undefined,
        model: this.config.model,
        dimension: this.config.dimension,
      });
    } catch {
      // ignore debug logging errors
    }

    const effectiveThreshold =
      threshold ?? this.config.similarityThreshold ?? Number.POSITIVE_INFINITY;
    return this.vectorStorage.search(vector, limit, effectiveThreshold);
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

  async indexTask(taskId: string): Promise<void> {
    const task = await this.findTaskById(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Get the full task content (title + spec content)
    const content = await this.extractTaskContent(task);
    const vector = await this.embeddingService.generateEmbedding(content);

    const contentHash = createHash("sha256").update(content).digest("hex");
    const metadata: Record<string, any> = {
      taskId,
      model: this.config.model,
      dimension: this.config.dimension,
      contentHash,
      updatedAt: new Date().toISOString(),
    };

    await this.vectorStorage.store(taskId, vector, metadata);
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

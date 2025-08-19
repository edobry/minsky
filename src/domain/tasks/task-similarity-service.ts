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

/**
 * Content structure for embeddings generation
 * This is designed to be domain-agnostic and reusable for md#447
 */
interface EmbeddingContent {
  title: string;
  summary?: string;
  keyTerms: string[];
  fullContent: string;
  metadata: {
    type: string;
    id: string;
    domain: string;
    contentHash: string;
  };
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
   * Extract structured content for embedding generation
   * This approach prepares for the generic similarity service in md#447
   */
  private async extractTaskContent(task: Task): Promise<string> {
    try {
      // Build structured content for better embeddings
      const embeddingContent = await this.buildEmbeddingContent(task);
      return this.formatContentForEmbedding(embeddingContent);
    } catch (error) {
      log.debug(`Failed to build structured content for task ${task.id}:`, error);
      // Fallback to simple concatenation
      return this.buildFallbackContent(task);
    }
  }

  /**
   * Build structured embedding content - designed for reuse in md#447
   */
  private async buildEmbeddingContent(task: Task): Promise<EmbeddingContent> {
    // Get full spec content
    const specData = await this.getTaskSpecContent(task.id);

    // Extract key terms from title (basic implementation)
    const keyTerms = this.extractKeyTerms(task.title);

    // Extract summary from spec content (first paragraph or Context section)
    const summary = this.extractSummary(specData.content);

    // Generate content hash for metadata
    const fullContent = specData.content || "";
    const contentHash = createHash("sha256")
      .update(task.title + fullContent)
      .digest("hex");

    return {
      title: task.title,
      summary,
      keyTerms,
      fullContent,
      metadata: {
        type: "task",
        id: task.id,
        domain: "tasks",
        contentHash,
      },
    };
  }

  /**
   * Format structured content for optimal embedding generation
   * This formatting strategy will be part of the generic service in md#447
   */
  private formatContentForEmbedding(content: EmbeddingContent): string {
    const sections: string[] = [];

    // Title is most important for semantic understanding
    sections.push(`Title: ${content.title}`);

    // Summary provides context without full detail
    if (content.summary) {
      sections.push(`Summary: ${content.summary}`);
    }

    // Key terms help with keyword matching
    if (content.keyTerms.length > 0) {
      sections.push(`Key Terms: ${content.keyTerms.join(", ")}`);
    }

    // Full content provides detailed context
    if (content.fullContent) {
      sections.push(`Content:\n${content.fullContent}`);
    }

    return sections.join("\n\n");
  }

  /**
   * Extract key terms from title for better searchability
   */
  private extractKeyTerms(title: string): string[] {
    // Basic key term extraction - will be improved in md#447
    const stopWords = new Set([
      "the",
      "a",
      "an",
      "and",
      "or",
      "but",
      "in",
      "on",
      "at",
      "to",
      "for",
      "of",
      "with",
      "by",
    ]);

    return title
      .toLowerCase()
      .split(/[\s\-_#]+/)
      .filter((term) => term.length > 2 && !stopWords.has(term))
      .slice(0, 5); // Limit to top 5 terms
  }

  /**
   * Extract summary from spec content
   */
  private extractSummary(content: string): string | undefined {
    if (!content) return undefined;

    // Look for Summary section first
    const summaryMatch = content.match(/##\s*Summary\s*\n(.*?)(?=\n##|\n#|$)/s);
    if (summaryMatch) {
      return summaryMatch[1].trim().substring(0, 200);
    }

    // Fall back to Context section
    const contextMatch = content.match(/##\s*Context\s*\n(.*?)(?=\n##|\n#|$)/s);
    if (contextMatch) {
      return contextMatch[1].trim().substring(0, 200);
    }

    // Fall back to first paragraph
    const firstParagraph = content.split("\n\n")[0];
    if (firstParagraph && firstParagraph.length > 20) {
      return firstParagraph.trim().substring(0, 200);
    }

    return undefined;
  }

  /**
   * Fallback content building for when structured approach fails
   */
  private buildFallbackContent(task: Task): string {
    const parts: string[] = [];

    if (task.title) {
      parts.push(task.title);
    }

    // Legacy fallback for description field
    if ((task as any).description) {
      parts.push((task as any).description);
    }

    return parts.join("\n\n");
  }
}

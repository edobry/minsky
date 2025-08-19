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

    // Debug: ANN search params
    try {
      log.debug("[tasks.search] Running ANN search", {
        limit,
        threshold: effectiveThreshold,
      });
    } catch {
      // ignore debug logging errors
    }

    let results = await this.vectorStorage.search(vector, limit, effectiveThreshold);

    // Deduplicate legacy vs qualified IDs, prefer qualified (e.g., md#123 over #123)
    const seen = new Set<string>();
    results = results.filter((r) => {
      const normalized =
        r.id.startsWith("md#") || r.id.includes("#") ? r.id.replace(/^#/, "md#") : r.id;
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });

    // Debug: ANN results (ids and scores)
    try {
      log.debug("[tasks.search] ANN results", {
        count: results.length,
        top: results.slice(0, 5),
      });
    } catch {
      // ignore debug logging errors
    }

    return results;
  }

  async indexTask(taskId: string): Promise<void> {
    const task = await this.findTaskById(taskId);
    if (!task) return;

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

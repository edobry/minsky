import type { Task } from "../tasks";
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
    private readonly config: TaskSimilarityServiceConfig = {}
  ) {}

  async similarToTask(taskId: string, limit = 10, threshold?: number): Promise<SearchResult[]> {
    const task = await this.findTaskById(taskId);
    if (!task) return [];
    const content = this.extractTaskContent(task);
    const vector = await this.embeddingService.generateEmbedding(content);
    const effectiveThreshold = threshold ?? this.config.similarityThreshold ?? 0.0;
    return this.vectorStorage.search(vector, limit, effectiveThreshold);
  }

  async searchByText(query: string, limit = 10, threshold?: number): Promise<SearchResult[]> {
    const vector = await this.embeddingService.generateEmbedding(query);
    const effectiveThreshold = threshold ?? this.config.similarityThreshold ?? 0.0;
    return this.vectorStorage.search(vector, limit, effectiveThreshold);
  }

  async indexTask(taskId: string): Promise<void> {
    const task = await this.findTaskById(taskId);
    if (!task) return;
    const content = this.extractTaskContent(task);
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

  private extractTaskContent(task: Task): string {
    const parts: string[] = [];
    if (task.title) parts.push(task.title);
    if ((task as any).description) parts.push((task as any).description);
    if ((task as any).metadata?.originalRequirements)
      parts.push((task as any).metadata.originalRequirements);
    return parts.join("\n\n");
  }
}

import type { EmbeddingService, VectorStorage, SearchResult } from "../ai/types";
import type { Task } from "../tasks";

export interface TaskSimilarityServiceConfig {
  similarityThreshold?: number;
  vectorLimit?: number;
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
    return await this.vectorStorage.search(
      vector,
      limit,
      threshold ?? this.config.similarityThreshold ?? 0.0
    );
  }

  async searchByText(query: string, limit = 10, threshold?: number): Promise<SearchResult[]> {
    const vector = await this.embeddingService.generateEmbedding(query);
    return await this.vectorStorage.search(
      vector,
      limit,
      threshold ?? this.config.similarityThreshold ?? 0.0
    );
  }

  private extractTaskContent(task: Task): string {
    const parts: string[] = [];
    if (task.title) parts.push(task.title);
    if ((task as any).description) parts.push((task as any).description);
    if (task.metadata?.originalRequirements) parts.push(task.metadata.originalRequirements);
    return parts.join("\n\n");
  }
}

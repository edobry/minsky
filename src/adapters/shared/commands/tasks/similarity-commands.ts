import { BaseTaskCommand, type BaseTaskParams } from "./base-task-command";
import type { CommandExecutionContext } from "../../command-registry";
import { TaskSimilarityService } from "../../../../domain/tasks/task-similarity-service";

interface TasksSimilarParams extends BaseTaskParams {
  taskId: string;
  limit?: number;
  threshold?: number;
}

interface TasksSearchParams extends BaseTaskParams {
  query: string;
  limit?: number;
  threshold?: number;
}

export class TasksSimilarCommand extends BaseTaskCommand {
  readonly id = "tasks.similar";
  readonly name = "similar";
  readonly description = "Find tasks similar to the given task using embeddings";

  async execute(params: TasksSimilarParams, ctx: CommandExecutionContext) {
    const taskId = this.validateRequired(params.taskId, "taskId");
    const limit = params.limit ?? 10;
    const threshold = params.threshold;

    const service = await this.createService();
    const results = await service.similarToTask(taskId, limit, threshold);

    return this.formatResult(
      {
        success: true,
        count: results.length,
        results,
      },
      params.json || ctx.format === "json"
    );
  }
}

export class TasksSearchCommand extends BaseTaskCommand {
  readonly id = "tasks.search";
  readonly name = "search";
  readonly description = "Search for tasks similar to a natural language query";

  async execute(params: TasksSearchParams, ctx: CommandExecutionContext) {
    const query = this.validateRequired(params.query, "query");
    const limit = params.limit ?? 10;
    const threshold = params.threshold;

    const service = await this.createService();
    const results = await service.searchByText(query, limit, threshold);

    return this.formatResult(
      {
        success: true,
        count: results.length,
        results,
      },
      params.json || ctx.format === "json"
    );
  }
}

// Temporary factory until full wiring is implemented
// Note: Uses placeholders for embedding/vector storages to be implemented next
import type { EmbeddingService, VectorStorage } from "../../../../domain/ai/types";
import { DefaultAIConfigurationService } from "../../../../domain/ai/config-service";
import { getConfiguration } from "../../../../domain/configuration";

async function createEmbeddingService(): Promise<EmbeddingService> {
  // Placeholder embedding service: throws until implemented
  return {
    async generateEmbedding(_content: string): Promise<number[]> {
      throw new Error("EmbeddingService not implemented");
    },
    async generateEmbeddings(_contents: string[]): Promise<number[][]> {
      throw new Error("EmbeddingService not implemented");
    },
  };
}

async function createVectorStorage(): Promise<VectorStorage> {
  return {
    async store(_id: string, _vector: number[], _metadata?: Record<string, any>): Promise<void> {
      throw new Error("VectorStorage not implemented");
    },
    async search(
      _queryVector: number[],
      _limit?: number,
      _threshold?: number
    ): Promise<import("../../../../domain/ai/types").SearchResult[]> {
      throw new Error("VectorStorage not implemented");
    },
    async delete(_id: string): Promise<void> {
      throw new Error("VectorStorage not implemented");
    },
  };
}

export async function createTaskSimilarityService(): Promise<TaskSimilarityService> {
  // Load AI config (for future provider wiring)
  const config = await getConfiguration();
  new DefaultAIConfigurationService(config); // constructed for future usage

  const embedding = await createEmbeddingService();
  const storage = await createVectorStorage();

  // Minimal task resolvers reuse domain functions via dynamic import to avoid cycles
  const tasksModule = await import("../../../../domain/tasks");
  const findTaskById = async (id: string) => tasksModule.getTask(id);
  const searchTasks = async (_: { text?: string }) => tasksModule.listTasks({});

  return new TaskSimilarityService(embedding, storage, findTaskById, searchTasks, {
    similarityThreshold: 0.0,
    vectorLimit: 10,
  });
}
// Helper on BaseTaskCommand to create service
declare module "./base-task-command" {
  interface BaseTaskCommand {
    createService: typeof createTaskSimilarityService;
  }
}

(BaseTaskCommand as any).prototype.createService = createTaskSimilarityService;

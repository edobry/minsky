import { BaseTaskCommand, type BaseTaskParams } from "./base-task-command";
import type { CommandExecutionContext } from "../../command-registry";
import { TaskSimilarityService } from "../../../domain/tasks/task-similarity-service";

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

import { createEmbeddingServiceFromConfig } from "../../../domain/ai/embedding-service-factory";
import { createVectorStorageFromConfig } from "../../../domain/storage/vector/vector-storage-factory";
import { getConfiguration } from "../../../domain/configuration";
import { getEmbeddingDimension } from "../../../domain/ai/embedding-models";

export async function createTaskSimilarityService(): Promise<TaskSimilarityService> {
  const cfg = await getConfiguration();
  const model = (cfg as any).embeddings?.model || "text-embedding-3-small";
  const dimension = getEmbeddingDimension(model, 1536);

  const embedding = await createEmbeddingServiceFromConfig();
  const storage = await createVectorStorageFromConfig(dimension);

  // Minimal task resolvers reuse domain functions via dynamic import to avoid cycles
  const tasksModule = await import("../../../domain/tasks");
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

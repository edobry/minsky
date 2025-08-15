import { BaseTaskCommand, type BaseTaskParams } from "./base-task-command";
import type { CommandExecutionContext } from "../../command-registry";
import { TaskSimilarityService } from "../../../../domain/tasks/task-similarity-service";
import { tasksSimilarParams, tasksSearchParams } from "./task-parameters";

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
  readonly parameters = tasksSimilarParams;

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
  readonly parameters = tasksSearchParams;

  async execute(params: TasksSearchParams, ctx: CommandExecutionContext) {
    const query = this.validateRequired(params.query, "query");
    const limit = params.limit ?? 10;
    const threshold = params.threshold;

    const service = await this.createService();

    try {
      const cfg = await (await import("../../../../domain/configuration")).getConfiguration();
      const provider =
        (cfg as any).embeddings?.provider || (cfg as any).ai?.defaultProvider || "openai";
      const model = (cfg as any).embeddings?.model || "text-embedding-3-small";
      const effThreshold =
        threshold ?? (service as any)?.config?.similarityThreshold ?? "(default)";
      this.debug(`tasks.search provider=${provider}, model=${model}`);
      this.debug(`tasks.search limit=${limit}, threshold=${String(effThreshold)}`);
    } catch {
      // ignore debug preflight errors
    }

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

import { createEmbeddingServiceFromConfig } from "../../../../domain/ai/embedding-service-factory";
import { createVectorStorageFromConfig } from "../../../../domain/storage/vector/vector-storage-factory";
import { getConfiguration } from "../../../../domain/configuration";
import { getEmbeddingDimension } from "../../../../domain/ai/embedding-models";

export async function createTaskSimilarityService(): Promise<TaskSimilarityService> {
  const cfg = await getConfiguration();
  const model = (cfg as any).embeddings?.model || "text-embedding-3-small";
  const dimension = getEmbeddingDimension(model, 1536);

  const embedding = await createEmbeddingServiceFromConfig();
  const storage = await createVectorStorageFromConfig(dimension);

  // Minimal task resolvers reuse domain functions via dynamic import to avoid cycles
  const tasksModule = await import("../../../../domain/tasks");
  const taskService = await (tasksModule as any).createConfiguredTaskService({
    backend: "markdown",
  });
  const findTaskById = async (id: string) => taskService.getTask(id);
  const searchTasks = async (_: { text?: string }) => taskService.listTasks({});

  return new TaskSimilarityService(embedding, storage, findTaskById, searchTasks, {
    similarityThreshold: 0.0,
    vectorLimit: 10,
    model,
    dimension,
  });
}

// Helper on BaseTaskCommand to create service
declare module "./base-task-command" {
  interface BaseTaskCommand {
    createService: typeof createTaskSimilarityService;
  }
}

(BaseTaskCommand as any).prototype.createService = createTaskSimilarityService;

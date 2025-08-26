import { BaseTaskCommand, type BaseTaskParams } from "./base-task-command";
import type { CommandExecutionContext } from "../../command-registry";
import { TaskSimilarityService } from "../../../../domain/tasks/task-similarity-service";
import { tasksSimilarParams, tasksSearchParams } from "./task-parameters";

interface TasksSimilarParams extends BaseTaskParams {
  taskId: string;
  limit?: number;
  threshold?: number;
  details?: boolean;
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

  /**
   * Enhance search results with task details for better CLI output
   */
  private async enhanceSearchResults(
    searchResults: Array<{ id: string; score?: number }>,
    includeDetails: boolean = false,
    includeSpecPath: boolean = true
  ): Promise<
    Array<{
      id: string;
      score?: number;
      title?: string;
      status?: string;
      specPath?: string;
      spec?: string;
    }>
  > {
    const enhanced = [];

    for (const result of searchResults) {
      try {
        // Get full task details
        const { createConfiguredTaskService } = await import(
          "../../../../domain/tasks/taskService"
        );
        const taskService = await createConfiguredTaskService({
          workspacePath: process.cwd(),
        });
        const task = await taskService.getTask(result.id);

        if (task) {
          enhanced.push({
            id: result.id,
            score: result.score,
            title: task.title,
            status: task.status,
            specPath: includeSpecPath ? (task as any).specPath : undefined,
            // Only include description if details requested
            description: includeDetails ? task.description : undefined,
          });
        } else {
          // Task not found, include minimal info
          enhanced.push({
            id: result.id,
            score: result.score,
            title: "(Task not found)",
            status: "UNKNOWN",
          });
        }
      } catch (error) {
        // Error loading task, include minimal info
        enhanced.push({
          id: result.id,
          score: result.score,
          title: "(Error loading task)",
          status: "ERROR",
        });
      }
    }

    return enhanced;
  }

  async execute(params: TasksSimilarParams, ctx: CommandExecutionContext) {
    const taskId = this.validateRequired(params.taskId, "taskId");
    const limit = params.limit ?? 10;
    const threshold = params.threshold;

    const service = await this.createService();
    const searchResults = await service.similarToTask(taskId, limit, threshold);

    // Enhance results with task details for better usability
    const includeSpecPath = (params as any).backend !== "minsky";
    const enhancedResults = await this.enhanceSearchResults(
      searchResults,
      params.details,
      includeSpecPath
    );

    return this.formatResult(
      {
        success: true,
        count: enhancedResults.length,
        results: enhancedResults,
        details: params.details, // Pass through details flag for CLI formatter
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

  /**
   * Enhance search results with task details for better CLI output
   */
  private async enhanceSearchResults(
    searchResults: Array<{ id: string; score?: number }>,
    includeDetails: boolean = false,
    includeSpecPath: boolean = true
  ): Promise<
    Array<{
      id: string;
      score?: number;
      title?: string;
      status?: string;
      specPath?: string;
      spec?: string;
    }>
  > {
    const enhanced = [];

    for (const result of searchResults) {
      try {
        // Get full task details
        const { createConfiguredTaskService } = await import(
          "../../../../domain/tasks/taskService"
        );
        const taskService = await createConfiguredTaskService({
          workspacePath: process.cwd(),
        });
        const task = await taskService.getTask(result.id);

        if (task) {
          enhanced.push({
            id: result.id,
            score: result.score,
            title: task.title,
            status: task.status,
            specPath: includeSpecPath ? (task as any).specPath : undefined,
            // Only include description if details requested
            description: includeDetails ? task.description : undefined,
          });
        } else {
          // Task not found, include minimal info
          enhanced.push({
            id: result.id,
            score: result.score,
            title: "(Task not found)",
            status: "UNKNOWN",
          });
        }
      } catch (error) {
        // Error loading task, include minimal info
        enhanced.push({
          id: result.id,
          score: result.score,
          title: "(Error loading task)",
          status: "ERROR",
        });
      }
    }

    return enhanced;
  }

  async execute(params: TasksSearchParams, ctx: CommandExecutionContext) {
    const query = this.validateRequired(params.query, "query");
    const limit = params.limit ?? 10;
    const threshold = params.threshold;

    const service = await this.createService();

    // Immediate progress hint to stderr unless JSON/quiet
    try {
      const { log } = await import("../../../../utils/logger");
      const quiet = Boolean((params as any).quiet);
      const json = Boolean((params as any).json) || ctx.format === "json";
      if (!quiet && !json) {
        log.cliWarn(`Searching for tasks matching: "${query}" ...`);
      }
    } catch {
      // ignore logging failures
    }

    // Optional human-friendly diagnostics (no global debug needed)
    if ((params as any).details) {
      try {
        const cfg = await (await import("../../../../domain/configuration")).getConfiguration();
        const provider =
          (cfg as any).embeddings?.provider || (cfg as any).ai?.defaultProvider || "openai";
        const model = (cfg as any).embeddings?.model || "text-embedding-3-small";
        const effThreshold =
          threshold ?? (service as any)?.config?.similarityThreshold ?? "(default)";
        // Print to CLI in human-friendly lines
        const { log } = await import("../../../../utils/logger");
        // Write diagnostics to stderr so --json stays clean on stdout
        log.cliWarn(`Search provider: ${provider}`);
        log.cliWarn(`Model: ${model}`);
        log.cliWarn(`Limit: ${limit}`);
        log.cliWarn(`Threshold: ${String(effThreshold)}`);
      } catch {
        // ignore details preflight errors
      }
    }

    const searchResults = await service.searchByText(query, limit, threshold);

    // Enhance results with task details for better usability
    const includeSpecPath = (params as any).backend !== "minsky";
    let enhancedResults = await this.enhanceSearchResults(
      searchResults,
      (params as any).details,
      includeSpecPath
    );

    // Apply status filtering using shared utility
    const { filterTasksByStatus } = await import("../../../../domain/tasks/task-filters");
    enhancedResults = filterTasksByStatus(enhancedResults, {
      status: (params as any).status as string | undefined,
      all: Boolean((params as any).all),
    });

    return this.formatResult(
      {
        success: true,
        count: enhancedResults.length,
        results: enhancedResults,
        details: params.details, // Pass through details flag for CLI formatter
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
  const { createConfiguredTaskService } = await import("../../../../domain/tasks/taskService");
  const taskService = await createConfiguredTaskService({ workspacePath: process.cwd() });
  const findTaskById = async (id: string) => taskService.getTask(id);
  const searchTasks = async (_: { text?: string }) => taskService.listTasks({});
  const getTaskSpecContent = async (id: string) => taskService.getTaskSpecContent(id);

  return new TaskSimilarityService(
    embedding,
    storage,
    findTaskById,
    searchTasks,
    getTaskSpecContent,
    {
      vectorLimit: 10,
      model,
      dimension,
    }
  );
}

// Helper on BaseTaskCommand to create service
declare module "./base-task-command" {
  interface BaseTaskCommand {
    createService: typeof createTaskSimilarityService;
  }
}

(BaseTaskCommand as any).prototype.createService = createTaskSimilarityService;

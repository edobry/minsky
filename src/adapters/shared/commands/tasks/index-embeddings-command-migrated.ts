/**
 * Tasks Index Embeddings Command - DatabaseCommand Migration
 * 
 * This command generates and stores embeddings for tasks using vector storage.
 * 
 * MIGRATION NOTES:
 * - OLD: Extended BaseTaskCommand, used createTaskSimilarityService() factory
 * - NEW: Extends DatabaseCommand, uses injected provider for TaskSimilarityService
 * - BENEFIT: No singleton access, proper dependency injection for vector storage
 */

import { DatabaseCommand, DatabaseCommandContext } from "../../../../domain/commands/database-command";
import { tasksIndexEmbeddingsParams } from "./task-parameters";
import { listTasksFromParams, getTaskFromParams } from "../../../../domain/tasks/taskCommands";
import { TaskSimilarityService } from "../../../../domain/tasks/task-similarity-service";
import { createEmbeddingServiceFromConfig } from "../../../../domain/ai/embedding-service-factory";
import { getConfiguration } from "../../../../domain/configuration";
import { getEmbeddingDimension } from "../../../../domain/ai/embedding-models";
import { CommandCategory } from "../../command-registry";
import { z } from "zod";

export class TasksIndexEmbeddingsCommand extends DatabaseCommand {
  readonly id = "tasks.index-embeddings";
  readonly category = CommandCategory.TASKS;
  readonly name = "index-embeddings";  
  readonly description = "Generate and store embeddings for tasks";
  readonly parameters = tasksIndexEmbeddingsParams;

  async execute(
    params: {
      limit?: number;
      task?: string;
      backend?: string;
      repo?: string;
      workspace?: string;
      session?: string;
      json?: boolean;
      concurrency?: number;
    },
    context: DatabaseCommandContext
  ) {
    try {
      const { provider } = context;

      // Check required capabilities
      if (!provider.capabilities.vectorStorage) {
        throw new Error("This command requires vector storage support");
      }

      // Create TaskSimilarityService with injected provider
      const service = await this.createTaskSimilarityService(provider);

      // If a specific task is provided, index just that one
      if (params.task) {
        const task = await getTaskFromParams({
          taskId: params.task,
          backend: params.backend,
          repo: params.repo,
          workspace: params.workspace,
          session: params.session,
          json: true,
        } as any);

        const { log } = await import("../../../../utils/logger");
        const changed = await service.indexTask(task.id);
        
        if (!params.json && context.format !== "json") {
          log.cli(`${task.id}: ${changed ? "indexed" : "up-to-date (skipped)"}`);
        }

        return {
          success: true,
          indexed: changed ? 1 : 0,
          skipped: changed ? 0 : 1,
        };
      }

      // Otherwise list and index up to limit
      const tasks = await listTasksFromParams({
        all: true,
        backend: params.backend,
        repo: params.repo,
        workspace: params.workspace,
        session: params.session,
        json: true,
        filter: undefined,
        limit: params.limit,
      });

      let indexed = 0;
      let skipped = 0;
      const { log } = await import("../../../../utils/logger");
      
      if (!params.json && context.format !== "json") {
        log.cli(`Indexing embeddings for ${tasks.length} task(s)...`);
      }

      // Concurrency control
      const concurrency = Math.max(1, Math.min(32, Number(params.concurrency) || 4));
      let i = 0;
      
      const worker = async () => {
        while (true) {
          const idx = i++;
          if (idx >= tasks.length) break;
          const t = tasks[idx];
          const changed = await service.indexTask(t.id);
          
          if (!params.json && context.format !== "json") {
            log.cli(`- ${t.id}: ${changed ? "indexed" : "up-to-date (skipped)"}`);
          }
          
          if (changed) indexed++;
          else skipped++;
        }
      };

      const workers = Array.from({ length: concurrency }, () => worker());
      await Promise.all(workers);
      
      if (!params.json && context.format !== "json") {
        log.cli("");
        log.cli(`Done. Indexed ${indexed} task(s); skipped ${skipped}.`);
      }

      return {
        success: true,
        indexed,
        skipped,
      };
    } catch (error) {
      throw error instanceof Error ? error : new Error("Unknown error occurred");
    }
  }

  /**
   * Create TaskSimilarityService with injected provider
   * This replaces the old createTaskSimilarityService factory function
   */
  private async createTaskSimilarityService(provider: any): Promise<TaskSimilarityService> {
    const cfg = await getConfiguration();
    const model = (cfg as any).embeddings?.model || "text-embedding-3-small";
    const dimension = getEmbeddingDimension(model, 1536);

    const embedding = await createEmbeddingServiceFromConfig();

    // Use injected provider for vector storage
    if (!provider.capabilities.vectorStorage) {
      throw new Error("Provider does not support vector storage");
    }
    
    const vectorStorage = await provider.getVectorStorage?.(dimension);
    if (!vectorStorage) {
      throw new Error("Failed to get vector storage from provider");
    }

    // Minimal task resolvers reuse domain functions via dynamic import to avoid cycles
    const { createConfiguredTaskService } = await import("../../../../domain/tasks/taskService");
    const taskService = await createConfiguredTaskService({ 
      workspacePath: process.cwd(),
      persistenceProvider: provider 
    });
    
    const findTaskById = async (id: string) => taskService.getTask(id);
    const searchTasks = async (_: { text?: string }) => taskService.listTasks({});
    const getTaskSpecContent = async (id: string) => taskService.getTaskSpecContent(id);

    const service = new TaskSimilarityService(
      embedding,
      vectorStorage,
      findTaskById,
      searchTasks,
      getTaskSpecContent
    );

    return service;
  }
}

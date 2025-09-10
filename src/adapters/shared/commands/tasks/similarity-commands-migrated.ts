/**
 * Migrated Similarity Commands
 * 
 * This file demonstrates how to migrate existing commands from the old pattern
 * (manual PersistenceService.initialize()) to the new DatabaseCommand pattern
 * with automatic provider injection.
 * 
 * MIGRATION EXAMPLE: TasksSimilarCommand and TasksSearchCommand
 */

import { z } from "zod";
import { DatabaseCommand, DatabaseCommandContext } from "../../../domain/commands/database-command";
import { CommandCategory } from "../../command-registry";
import { TaskStatus } from "../../../../domain/tasks/taskConstants";
import { TaskSimilarityService } from "../../../../domain/tasks/task-similarity-service";
import { createEmbeddingServiceFromConfig } from "../../../../domain/ai/embedding-service-factory";
import { getConfiguration } from "../../../../domain/configuration";
import { getEmbeddingDimension } from "../../../../domain/ai/embedding-models";
import type { EnhancedSearchResult } from "../similarity-command-factory";

/**
 * MIGRATED: Task Similar Command
 * 
 * OLD PATTERN: Extended BaseTaskCommand, called createService() which internally 
 * called PersistenceService.initialize()
 * 
 * NEW PATTERN: Extends DatabaseCommand, receives provider via context injection
 */
export class TasksSimilarCommandMigrated extends DatabaseCommand {
  readonly id = "tasks.similar-migrated";
  readonly category = CommandCategory.TASKS;
  readonly name = "similar";
  readonly description = "Find tasks similar to the given task using embeddings";

  readonly parameters = {
    taskId: {
      schema: z.string(),
      spec: "Task ID to find similar tasks for",
      required: true,
    },
    limit: {
      schema: z.number().min(1).max(100).optional(),
      spec: "Maximum number of similar tasks to return",
      required: false,
      defaultValue: 10,
    },
    threshold: {
      schema: z.number().min(0).max(1).optional(),
      spec: "Minimum similarity threshold",
      required: false,
    },
    details: {
      schema: z.boolean().optional(),
      spec: "Include detailed task information",
      required: false,
      defaultValue: false,
    },
    backend: {
      schema: z.string().optional(),
      spec: "Task backend to use",
      required: false,
    },
  } as const;

  async execute(
    params: {
      taskId: string;
      limit?: number;
      threshold?: number;
      details?: boolean;
      backend?: string;
    },
    context: DatabaseCommandContext
  ) {
    // Provider is automatically injected and initialized by CommandDispatcher
    const { provider } = context;

    // Create the similarity service with the injected provider
    // NO MORE: await PersistenceService.initialize()
    const service = await this.createTaskSimilarityService(provider);

    // Execute the similarity search
    const searchResults = await service.similarToTask(
      params.taskId,
      params.limit ?? 10,
      params.threshold
    );

    // Enhance results with task details for better usability
    const includeSpecPath = params.backend !== "minsky";
    const enhancedResults = await this.enhanceSearchResults(
      searchResults,
      params.details,
      includeSpecPath
    );

    return {
      success: true,
      count: enhancedResults.length,
      results: enhancedResults,
      details: params.details,
    };
  }

  /**
   * Create TaskSimilarityService with injected provider
   * 
   * MIGRATION NOTE: This replaces the old createTaskSimilarityService function
   * that manually initialized PersistenceService. Now it receives the provider
   * as a parameter from the context.
   */
  private async createTaskSimilarityService(provider: any): Promise<TaskSimilarityService> {
    const cfg = await getConfiguration();
    const model = (cfg as any).embeddings?.model || "text-embedding-3-small";
    const dimension = getEmbeddingDimension(model, 1536);

    const embedding = await createEmbeddingServiceFromConfig();

    // OLD: await PersistenceService.initialize(); const persistence = PersistenceService.getProvider();
    // NEW: Use the injected provider directly
    const persistence = provider;

    // Minimal task resolvers reuse domain functions via dynamic import to avoid cycles
    const { createConfiguredTaskService } = await import("../../../../domain/tasks/taskService");
    const taskService = await createConfiguredTaskService({ workspacePath: process.cwd() });
    const findTaskById = async (id: string) => taskService.getTask(id);
    const searchTasks = async (_: { text?: string }) => taskService.listTasks({});
    const getTaskSpecContent = async (id: string) => taskService.getTaskSpecContent(id);

    const service = new TaskSimilarityService(
      embedding,
      persistence,
      findTaskById,
      searchTasks,
      getTaskSpecContent,
      {
        vectorLimit: 10,
        model,
        dimension,
      }
    );

    // Initialize the service to set up vector storage
    await service.initialize();

    return service;
  }

  /**
   * Enhance search results with task details for better CLI output
   */
  private async enhanceSearchResults(
    searchResults: Array<{ id: string; score?: number }>,
    includeDetails: boolean = false,
    includeSpecPath: boolean = true
  ): Promise<EnhancedSearchResult[]> {
    const enhanced: EnhancedSearchResult[] = [];

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
            name: task.title,
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
            name: "(Task not found)",
            status: "UNKNOWN",
          });
        }
      } catch (error) {
        // Error loading task, include minimal info
        enhanced.push({
          id: result.id,
          score: result.score,
          name: "(Error loading task)",
          status: "ERROR",
        });
      }
    }

    return enhanced;
  }
}

/**
 * MIGRATED: Task Search Command
 * 
 * OLD PATTERN: Extended BaseTaskCommand, called createService() which internally 
 * called PersistenceService.initialize()
 * 
 * NEW PATTERN: Extends DatabaseCommand, receives provider via context injection
 */
export class TasksSearchCommandMigrated extends DatabaseCommand {
  readonly id = "tasks.search-migrated";
  readonly category = CommandCategory.TASKS;
  readonly name = "search";
  readonly description = "Search for tasks similar to a natural language query";

  readonly parameters = {
    query: {
      schema: z.string().min(1),
      spec: "Natural language query to search for",
      required: true,
    },
    limit: {
      schema: z.number().min(1).max(100).optional(),
      spec: "Maximum number of search results to return",
      required: false,
      defaultValue: 10,
    },
    threshold: {
      schema: z.number().min(0).max(1).optional(),
      spec: "Minimum similarity threshold",
      required: false,
    },
    details: {
      schema: z.boolean().optional(),
      spec: "Include detailed task information",
      required: false,
      defaultValue: false,
    },
    all: {
      schema: z.boolean().optional(),
      spec: "Include DONE and CLOSED tasks in search results",
      required: false,
      defaultValue: false,
    },
    status: {
      schema: z.string().optional(),
      spec: "Filter by task status",
      required: false,
    },
    backend: {
      schema: z.string().optional(),
      spec: "Task backend to use",
      required: false,
    },
  } as const;

  async execute(
    params: {
      query: string;
      limit?: number;
      threshold?: number;
      details?: boolean;
      all?: boolean;
      status?: string;
      backend?: string;
    },
    context: DatabaseCommandContext
  ) {
    // Provider is automatically injected and initialized by CommandDispatcher
    const { provider } = context;

    // Create the similarity service with the injected provider
    const service = await this.createTaskSimilarityService(provider);

    // Build filters from parameters for server-side filtering
    const filters: Record<string, any> = {};

    // Add backend filter if provided
    if (params.backend) {
      filters.backend = params.backend;
    }

    // Add status filter if provided and not showing all
    if (params.status && !params.all) {
      filters.status = params.status;
    } else if (!params.all) {
      // Default: exclude DONE and CLOSED tasks unless --all is specified
      filters.statusExclude = [TaskStatus.DONE, TaskStatus.CLOSED];
    }

    const searchResults = await service.searchByText(
      params.query,
      params.limit ?? 10,
      params.threshold,
      filters
    );

    // Enhance results with task details for better usability
    const includeSpecPath = params.backend !== "minsky";
    const enhancedResults = await this.enhanceSearchResults(
      searchResults,
      params.details,
      includeSpecPath
    );

    return {
      success: true,
      count: enhancedResults.length,
      results: enhancedResults,
      details: params.details,
    };
  }

  /**
   * Create TaskSimilarityService with injected provider
   * (Same implementation as TasksSimilarCommandMigrated)
   */
  private async createTaskSimilarityService(provider: any): Promise<TaskSimilarityService> {
    const cfg = await getConfiguration();
    const model = (cfg as any).embeddings?.model || "text-embedding-3-small";
    const dimension = getEmbeddingDimension(model, 1536);

    const embedding = await createEmbeddingServiceFromConfig();

    // NEW: Use the injected provider directly
    const persistence = provider;

    // Minimal task resolvers reuse domain functions via dynamic import to avoid cycles
    const { createConfiguredTaskService } = await import("../../../../domain/tasks/taskService");
    const taskService = await createConfiguredTaskService({ workspacePath: process.cwd() });
    const findTaskById = async (id: string) => taskService.getTask(id);
    const searchTasks = async (_: { text?: string }) => taskService.listTasks({});
    const getTaskSpecContent = async (id: string) => taskService.getTaskSpecContent(id);

    const service = new TaskSimilarityService(
      embedding,
      persistence,
      findTaskById,
      searchTasks,
      getTaskSpecContent,
      {
        vectorLimit: 10,
        model,
        dimension,
      }
    );

    // Initialize the service to set up vector storage
    await service.initialize();

    return service;
  }

  /**
   * Enhance search results with task details for better CLI output
   * (Same implementation as TasksSimilarCommandMigrated - could be extracted to shared helper)
   */
  private async enhanceSearchResults(
    searchResults: Array<{ id: string; score?: number }>,
    includeDetails: boolean = false,
    includeSpecPath: boolean = true
  ): Promise<EnhancedSearchResult[]> {
    const enhanced: EnhancedSearchResult[] = [];

    for (const result of searchResults) {
      try {
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
            name: task.title,
            status: task.status,
            specPath: includeSpecPath ? (task as any).specPath : undefined,
            description: includeDetails ? task.description : undefined,
          });
        } else {
          enhanced.push({
            id: result.id,
            score: result.score,
            name: "(Task not found)",
            status: "UNKNOWN",
          });
        }
      } catch (error) {
        enhanced.push({
          id: result.id,
          score: result.score,
          name: "(Error loading task)",
          status: "ERROR",
        });
      }
    }

    return enhanced;
  }
}

/**
 * MIGRATION SUMMARY:
 * 
 * KEY CHANGES FROM OLD TO NEW:
 * 
 * 1. INHERITANCE:
 *    OLD: extends BaseTaskCommand
 *    NEW: extends DatabaseCommand
 * 
 * 2. PROVIDER ACCESS:
 *    OLD: await PersistenceService.initialize(); const provider = PersistenceService.getProvider();
 *    NEW: const { provider } = context; // Automatically injected and initialized
 * 
 * 3. PARAMETER VALIDATION:
 *    OLD: Manual validation with this.validateRequired()
 *    NEW: Zod schemas with compile-time type safety
 * 
 * 4. EXECUTION CONTEXT:
 *    OLD: CommandExecutionContext
 *    NEW: DatabaseCommandContext (with guaranteed provider)
 * 
 * 5. SERVICE CREATION:
 *    OLD: this.createService() (via prototype extension)
 *    NEW: this.createTaskSimilarityService(provider) (direct method with injected provider)
 * 
 * BENEFITS OF MIGRATION:
 * - Automatic provider initialization only when needed
 * - Compile-time type safety for parameters
 * - Clean dependency injection for testing
 * - Consistent error handling
 * - Better performance (no database connections for non-database commands)
 * - Unified architecture for CLI and MCP
 */

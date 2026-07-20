import { BaseTaskCommand } from "./base-task-command";
import type { CommandExecutionContext, InferParams } from "../../command-registry";
import { TaskStatus } from "@minsky/domain/tasks/taskConstants";
import { TaskSimilarityService } from "@minsky/domain/tasks/task-similarity-service";
import { tasksSimilarParams, tasksSearchParams } from "./task-parameters";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import { assertKnownKind } from "@minsky/domain/tasks/workflows";
import { ALL_PROJECTS, type ProjectScope } from "@minsky/domain/project/scope";
import { resolveProjectIdentity } from "@minsky/domain/project/identity";
import { resolveProjectScope } from "@minsky/domain/project/scope-resolver";
import { log } from "@minsky/shared/logger";

/**
 * Resolve the current project scope for tasks_similar / tasks_search (ADR-021,
 * mt#2939) — mirrors listTasksFromParams' resolution in packages/domain/src/tasks.ts
 * (mt#2416), reused here since TaskSimilarityService's constructor takes a
 * `persistenceProvider` directly rather than a CommandExecutionContext.
 *
 * Returns ALL_PROJECTS when: the caller passed `allProjects: true`, the project
 * identity is unresolved, the persistence provider has no SQL capability, or
 * resolution otherwise fails. Never throws (fail-open, per ADR-021 §Decision).
 */
async function resolveTaskSimilarityProjectScope(
  allProjects: boolean | undefined,
  persistenceProvider: import("@minsky/domain/persistence/types").PersistenceProvider
): Promise<ProjectScope> {
  if (allProjects) return ALL_PROJECTS;

  try {
    const identity = resolveProjectIdentity({ repoPath: process.cwd() });
    if (identity.kind !== "resolved") return ALL_PROJECTS;
    if (
      !persistenceProvider ||
      !persistenceProvider.capabilities.sql ||
      typeof persistenceProvider.getDatabaseConnection !== "function"
    ) {
      return ALL_PROJECTS;
    }
    // Cast to the SQL-capable interface (mirrors packages/domain/src/tasks.ts's
    // listTasksFromParams, mt#2416): the base PersistenceProvider class types
    // getDatabaseConnection() as Promise<unknown> since subclasses return
    // different concrete DB types; SqlCapablePersistenceProvider narrows it to
    // the PostgresJsDatabase shape resolveProjectScope's ScopeResolverDb needs.
    const sqlProvider =
      persistenceProvider as import("@minsky/domain/persistence/types").SqlCapablePersistenceProvider;
    const db = await sqlProvider.getDatabaseConnection();
    if (!db) return ALL_PROJECTS;
    return await resolveProjectScope(identity, db);
  } catch (err) {
    log.debug("[tasks.similar] Project scope resolution failed; defaulting to ALL_PROJECTS", {
      error: err instanceof Error ? err.message : String(err),
    });
    return ALL_PROJECTS;
  }
}

export class TasksSimilarCommand extends BaseTaskCommand<typeof tasksSimilarParams> {
  readonly id = "tasks.similar";
  readonly name = "similar";
  readonly description = "Find tasks similar to the given task using embeddings";
  readonly parameters = tasksSimilarParams;

  constructor(
    private readonly getPersistenceProvider: () => import("@minsky/domain/persistence/types").PersistenceProvider,
    private readonly getTaskService: () => TaskServiceInterface
  ) {
    super();
  }

  /**
   * Enhance search results with task details for better CLI output
   */
  private async enhanceSearchResults(
    searchResults: Array<{ id: string; score?: number }>,
    includeDetails: boolean = false
  ): Promise<
    Array<{
      id: string;
      score?: number;
      title?: string;
      status?: string;
      spec?: string;
    }>
  > {
    const enhanced: Array<{
      id: string;
      score?: number;
      title?: string;
      status?: string;
      spec?: string;
    }> = [];

    for (const result of searchResults) {
      try {
        // Get full task details
        const taskService = this.getTaskService();
        if (!taskService) {
          enhanced.push({
            id: result.id,
            score: result.score,
            title: "(No task service)",
            status: "UNKNOWN",
          });
          continue;
        }
        const task = await taskService.getTask(result.id);

        if (task) {
          enhanced.push({
            id: result.id,
            score: result.score,
            title: task.title,
            status: task.status,
            // Only include spec if details requested
            spec: includeDetails ? task.spec : undefined,
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

  async execute(params: InferParams<typeof tasksSimilarParams>, ctx: CommandExecutionContext) {
    const taskId = this.validateRequired(params.taskId, "taskId");
    const limit = params.limit ?? 10;
    const threshold = params.threshold;

    // ADR-021 / mt#2939: resolve project scope for this similarity query.
    const projectScope = await resolveTaskSimilarityProjectScope(
      params.allProjects,
      this.getPersistenceProvider()
    );

    const service = await this.createService(this.getPersistenceProvider(), this.getTaskService());
    const response = await service.similarToTask(taskId, limit, threshold, projectScope);

    // Enhance results with task details for better usability
    const enhancedResults = await this.enhanceSearchResults(response.results, params.details);

    // Show degraded warning to stderr unless JSON/quiet
    if (response.degraded) {
      try {
        const { log } = await import("@minsky/shared/logger");
        // mt#2795: `quiet` is now a DECLARED param (parity with tasks.search),
        // resolving the gap mt#2779 documented when it removed the prior ghost
        // read of the then-undeclared key.
        const quiet = Boolean(params.quiet);
        const json = Boolean(params.json) || ctx.format === "json";
        if (!quiet && !json) {
          log.cliWarn(
            `Warning: similarity search degraded — using lexical fallback: ` +
              `${response.degradedReason ?? "unknown"}. ` +
              `Run 'minsky config doctor' to diagnose.`
          );
        }
      } catch {
        // ignore logging failures
      }
    }

    return this.formatResult(
      {
        success: true,
        count: enhancedResults.length,
        results: enhancedResults,
        backend: response.backend,
        degraded: response.degraded,
        degradedReason: response.degradedReason,
        details: params.details, // Pass through details flag for CLI formatter
      },
      params.json || ctx.format === "json"
    );
  }
}

export class TasksSearchCommand extends BaseTaskCommand<typeof tasksSearchParams> {
  readonly id = "tasks.search";
  readonly name = "search";
  readonly description = "Search for tasks similar to a natural language query";
  readonly parameters = tasksSearchParams;

  constructor(
    private readonly getPersistenceProvider: () => import("@minsky/domain/persistence/types").PersistenceProvider,
    private readonly getTaskService: () => TaskServiceInterface
  ) {
    super();
  }

  /**
   * Enhance search results with task details for better CLI output
   */
  private async enhanceSearchResults(
    searchResults: Array<{ id: string; score?: number }>,
    includeDetails: boolean = false
  ): Promise<
    Array<{
      id: string;
      score?: number;
      title?: string;
      status?: string;
      spec?: string;
    }>
  > {
    const enhanced: Array<{
      id: string;
      score?: number;
      title?: string;
      status?: string;
      spec?: string;
    }> = [];

    for (const result of searchResults) {
      try {
        // Get full task details
        const taskService = this.getTaskService();
        if (!taskService) {
          enhanced.push({
            id: result.id,
            score: result.score,
            title: "(No task service)",
            status: "UNKNOWN",
          });
          continue;
        }
        const task = await taskService.getTask(result.id);

        if (task) {
          enhanced.push({
            id: result.id,
            score: result.score,
            title: task.title,
            status: task.status,
            // Only include spec if details requested
            spec: includeDetails ? task.spec : undefined,
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

  async execute(params: InferParams<typeof tasksSearchParams>, ctx: CommandExecutionContext) {
    const query = this.validateRequired(params.query, "query");
    const limit = params.limit ?? 10;
    const threshold = params.threshold;

    // Validate kind against the workflow registry up front (mt#2762), mirroring
    // tasks_list / tasks_edit — a typo must not silently return zero results.
    assertKnownKind(params.kind);

    const service = await this.createService(this.getPersistenceProvider(), this.getTaskService());

    // Immediate progress hint to stderr unless JSON/quiet
    try {
      const { log } = await import("@minsky/shared/logger");
      const quiet = Boolean(params.quiet);
      const json = Boolean(params.json) || ctx.format === "json";
      if (!quiet && !json) {
        log.cliWarn(`Searching for tasks matching: "${query}" ...`);
      }
    } catch {
      // ignore logging failures
    }

    // Optional human-friendly diagnostics (no global debug needed)
    if (params.details) {
      try {
        const cfg = await (await import("@minsky/domain/configuration")).getConfiguration();
        const provider = cfg.embeddings?.provider || cfg.ai?.defaultProvider || "openai";
        const model = cfg.embeddings?.model || "text-embedding-3-small";
        const effThreshold = threshold ?? service.getConfig()?.similarityThreshold ?? "(default)";
        // Print to CLI in human-friendly lines
        const { log } = await import("@minsky/shared/logger");
        // Write diagnostics to stderr so --json stays clean on stdout
        log.cliWarn(`Search provider: ${provider}`);
        log.cliWarn(`Model: ${model}`);
        log.cliWarn(`Limit: ${limit}`);
        log.cliWarn(`Threshold: ${String(effThreshold)}`);
      } catch {
        // ignore details preflight errors
      }
    }

    // Build domain filters from CLI parameters. These are applied at READ TIME against
    // the live `tasks` table inside TaskSimilarityService.searchByText (over-fetch +
    // post-filter), NOT pushed into the vector store as denormalized-column filters.
    // See docs/architecture/adr-013-filtered-vector-search.md.
    const filters: Record<string, unknown> = {};

    // Add backend filter if provided
    if (params.backend) {
      filters.backend = params.backend;
    }

    // Add workflow-kind filter if provided (mt#2762)
    if (params.kind) {
      filters.kind = params.kind;
    }

    // Add status filter if provided and not showing all
    const showAll = Boolean(params.all);
    if (params.status && !showAll) {
      filters.status = params.status;
    } else if (!showAll) {
      // Default: exclude DONE and CLOSED tasks unless --all is specified
      // This matches the behavior of tasks list command (mt#477)
      filters.statusExclude = [TaskStatus.DONE, TaskStatus.CLOSED];
    }

    // ADR-021 / mt#2939: resolve project scope for this search query.
    const projectScope = await resolveTaskSimilarityProjectScope(
      params.allProjects,
      this.getPersistenceProvider()
    );

    const response = await service.searchByText(query, limit, threshold, filters, projectScope);

    // Show backend info to stderr unless JSON/quiet
    try {
      const { log } = await import("@minsky/shared/logger");
      const quiet = Boolean(params.quiet);
      const json = Boolean(params.json) || ctx.format === "json";
      if (!quiet && !json) {
        if (response.degraded) {
          log.cliWarn(
            `Warning: similarity search degraded — using lexical fallback: ` +
              `${response.degradedReason ?? "unknown"}. ` +
              `Run 'minsky config doctor' to diagnose.`
          );
        } else {
          const backendLabel =
            response.backend === "embeddings" ? "embeddings" : response.backend || "lexical";
          log.cliWarn(`Search backend: ${backendLabel}`);
        }
      }
    } catch {
      // ignore logging failures
    }

    // Enhance results with task details for better usability. response.results is
    // already filtered and truncated to `limit` by the service's read-time domain
    // filter, so no client-side filtering is needed here.
    const enhancedResults = await this.enhanceSearchResults(response.results, params.details);

    return this.formatResult(
      {
        success: true,
        count: enhancedResults.length,
        results: enhancedResults,
        backend: response.backend,
        degraded: response.degraded,
        degradedReason: response.degradedReason,
        details: params.details, // Pass through details flag for CLI formatter
      },
      params.json || ctx.format === "json"
    );
  }
}

import { createEmbeddingServiceFromConfig } from "@minsky/domain/ai/embedding-service-factory";
import { getConfiguration } from "@minsky/domain/configuration";
import { getEmbeddingDimension } from "@minsky/domain/ai/embedding-models";

export async function createTaskSimilarityService(
  persistenceProvider: import("@minsky/domain/persistence/types").BasePersistenceProvider,
  taskService: TaskServiceInterface
): Promise<TaskSimilarityService> {
  const cfg = await getConfiguration();
  const model = cfg.embeddings?.model || "text-embedding-3-small";
  const dimension = getEmbeddingDimension(model, 1536);

  const embedding = await createEmbeddingServiceFromConfig();

  const resolvedProvider = persistenceProvider;

  // Check vector capability
  if (
    !resolvedProvider.capabilities.vectorStorage ||
    !("getVectorStorageForDomain" in resolvedProvider) ||
    typeof (resolvedProvider as Record<string, unknown>).getVectorStorageForDomain !== "function"
  ) {
    throw new Error(
      `Persistence provider ${resolvedProvider.constructor.name} does not support vector storage`
    );
  }
  const vectorStorage = (
    resolvedProvider as import("@minsky/domain/persistence/types").VectorCapablePersistenceProvider
  ).getVectorStorageForDomain("tasks", dimension);

  const findTaskById = async (id: string) => taskService.getTask(id);
  // mt#2939: forward the caller-resolved projectScope (if any) into the live
  // tasks-table read — this is what closes the cross-project leak on both the
  // fast-path (similarToTask / no-filter searchByText) and filtered-path callers.
  const searchTasks = async (opts: { text?: string; projectScope?: ProjectScope }) =>
    taskService.listTasks({ projectScope: opts?.projectScope });
  const getTaskSpecContent = async (id: string) => taskService.getTaskSpecContent(id);

  const service = new TaskSimilarityService(
    embedding,
    vectorStorage,
    findTaskById,
    searchTasks,
    getTaskSpecContent,
    {
      vectorLimit: 10,
      model,
      dimension,
    }
  );

  // Service is ready to use immediately - no initialization needed
  return service;
}

// Helper on BaseTaskCommand to create service
declare module "./base-task-command" {
  interface BaseTaskCommand {
    createService: typeof createTaskSimilarityService;
  }
}

Object.assign(BaseTaskCommand.prototype, { createService: createTaskSimilarityService });

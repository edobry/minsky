/**
 * Task CRUD Commands
 *
 * Commands for creating, reading, updating, and deleting tasks.
 * Extracted from tasks.ts as part of modularization effort.
 */
import { type CommandExecutionContext } from "../../command-registry";
// Domain task functions are lazy-imported inside execute methods to avoid
// loading the entire domain layer at command registration time.
import { ValidationError, ResourceNotFoundError } from "../../../../errors/index";
import { getErrorMessage } from "../../../../errors/index";
import { BaseTaskCommand, type BaseTaskParams } from "./base-task-command";
import {
  tasksListParams,
  tasksGetParams,
  tasksCreateParams,
  tasksDeleteParams,
} from "./task-parameters";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PersistenceProvider } from "../../../../domain/persistence/types";
import { log } from "../../../../utils/logger";
import { autoIndexTaskEmbedding } from "./auto-index-embedding";

/**
 * Parameters for tasks list command
 */
interface TasksListParams extends BaseTaskParams {
  all?: boolean;
  status?: string;
  filter?: string;
  limit?: number;
  tag?: string | string[];
  since?: string;
  until?: string;
  hierarchical?: boolean;
  showDeps?: boolean;
}

/**
 * Parameters for tasks get command
 */
interface TasksGetParams extends BaseTaskParams {
  taskId: string;
  includeSpec?: boolean;
  includeSubtasks?: boolean;
}

/**
 * Parameters for tasks create command
 */
interface TasksCreateParams extends BaseTaskParams {
  title: string;
  description?: string;
  spec?: string;
  force?: boolean;
  githubRepo?: string;
  dependsOn?: string | string[];
  parent?: string;
  tag?: string | string[];
}

/**
 * Parameters for tasks delete command
 */
interface TasksDeleteParams extends BaseTaskParams {
  taskId: string;
  force?: boolean;
}

/**
 * Task list command implementation
 */
export class TasksListCommand extends BaseTaskCommand<TasksListParams> {
  readonly id = "tasks.list";
  readonly name = "list";
  readonly description = "List tasks with optional filtering";
  readonly parameters = tasksListParams;

  constructor(private readonly getPersistenceProvider: () => PersistenceProvider) {
    super();
  }

  async execute(params: TasksListParams, ctx: CommandExecutionContext) {
    this.debug("Starting tasks.list execution");
    this.debug(`Context format: ${ctx.format}, params.json: ${params.json}`);
    const { listTasksFromParams } = await import("../../../../domain/tasks");

    // Normalize tag param to string array for domain layer
    const tags = params.tag ? (Array.isArray(params.tag) ? params.tag : [params.tag]) : undefined;

    // Validate tags don't use reserved minsky: prefix
    if (tags) {
      const invalidTags = tags.filter((t) => t.startsWith("minsky:"));
      if (invalidTags.length > 0) {
        throw new ValidationError(
          `Tags cannot use the reserved "minsky:" prefix: ${invalidTags.join(", ")}`
        );
      }
    }

    // List tasks with filters
    let tasks = await listTasksFromParams(
      {
        ...this.createTaskParams(params),
        all: params.all,
        status: params.status,
        filter: params.filter,
        limit: params.limit,
        tags,
      },
      { persistenceProvider: this.getPersistenceProvider() }
    );

    // Apply shared filters for backend/time at adapter level (until domain exposes them)
    try {
      const { parseTime, filterByTimeRange } = require("../../../../utils/result-handling/filters");
      const sinceTs = parseTime(params.since);
      const untilTs = parseTime(params.until);
      tasks = filterByTimeRange(tasks, sinceTs, untilTs);
    } catch {
      // If utilities unavailable, skip
    }

    // Enrich with parent info and build hierarchical view if requested
    let depthMap: Map<string, number> | undefined;
    if (params.hierarchical) {
      try {
        const persistence = this.getPersistenceProvider();
        const db = (await persistence.getDatabaseConnection?.()) as PostgresJsDatabase;
        const { TaskGraphService } = await import("../../../../domain/tasks/task-graph-service");
        const service = new TaskGraphService(db);
        const taskIds = tasks.map((t) => t.id);
        const parentEdges = await service.getRelationshipsForTasks(taskIds, "parent");

        // Build parent map: childId → parentId
        const parentMap = new Map<string, string>();
        for (const edge of parentEdges) {
          parentMap.set(edge.fromTaskId, edge.toTaskId);
        }

        // Enrich tasks with parentTaskId
        for (const task of tasks) {
          const parent = parentMap.get(task.id);
          if (parent) task.parentTaskId = parent;
        }

        // Build tree output: root tasks first, then children indented
        const taskById = new Map(tasks.map((t) => [t.id, t]));
        const childrenMap = new Map<string, typeof tasks>();
        const rootTasks: typeof tasks = [];

        for (const task of tasks) {
          if (task.parentTaskId && taskById.has(task.parentTaskId)) {
            if (!childrenMap.has(task.parentTaskId)) {
              childrenMap.set(task.parentTaskId, []);
            }
            childrenMap.get(task.parentTaskId)?.push(task);
          } else {
            rootTasks.push(task);
          }
        }

        // Flatten tree back to ordered array with depth tracked separately
        const orderedTasks: typeof tasks = [];
        depthMap = new Map<string, number>();
        const localDepthMap = depthMap;
        const addWithChildren = (task: (typeof tasks)[0], depth: number) => {
          localDepthMap.set(task.id, depth);
          orderedTasks.push(task);
          const children = childrenMap.get(task.id) ?? [];
          for (const child of children) {
            addWithChildren(child, depth + 1);
          }
        };
        for (const root of rootTasks) {
          addWithChildren(root, 0);
        }

        tasks = orderedTasks;
      } catch {
        // If graph service unavailable, fall back to flat list
      }
    } else if (params.hierarchical) {
      log.warn(
        "[tasks.list] Hierarchical view unavailable — no persistence provider (no SQL backend)"
      );
    }

    // Enrich with dependency status if requested
    let depsStatusMap: Map<string, { ready: boolean; blockedBy: string[] }> | undefined;
    if (params.showDeps) {
      try {
        const persistence = this.getPersistenceProvider();
        const db = (await persistence.getDatabaseConnection?.()) as PostgresJsDatabase;
        const { TaskGraphService } = await import("../../../../domain/tasks/task-graph-service");
        const service = new TaskGraphService(db);
        const taskIds = tasks.map((t) => t.id);
        const depEdges = await service.getRelationshipsForTasks(taskIds, "depends");

        // Build dependency map: taskId → [depIds]
        const depMap = new Map<string, string[]>();
        for (const edge of depEdges) {
          if (!depMap.has(edge.fromTaskId)) depMap.set(edge.fromTaskId, []);
          depMap.get(edge.fromTaskId)?.push(edge.toTaskId);
        }

        // Check which deps are unmet (not DONE/CLOSED)
        const taskById = new Map(tasks.map((t) => [t.id, t]));
        depsStatusMap = new Map();
        for (const task of tasks) {
          const deps = depMap.get(task.id) ?? [];
          if (deps.length === 0) {
            depsStatusMap.set(task.id, { ready: true, blockedBy: [] });
          } else {
            const blockedBy: string[] = [];
            for (const depId of deps) {
              const depTask = taskById.get(depId);
              const status = depTask?.status;
              if (status !== "DONE" && status !== "CLOSED") {
                blockedBy.push(depId);
              }
            }
            depsStatusMap.set(task.id, { ready: blockedBy.length === 0, blockedBy });
          }
        }
      } catch {
        // Graph service unavailable, skip dep status
      }
    }

    this.debug(`Found ${tasks.length} tasks`);
    const wantJson = params.json || ctx.format === "json";
    if (wantJson) {
      // For JSON output, return tasks array only
      return tasks;
    }

    // Format output with optional hierarchy and dependency status
    if (params.hierarchical || params.showDeps) {
      const lines: string[] = [];
      for (const task of tasks) {
        const depth = params.hierarchical ? (depthMap?.get(task.id) ?? 0) : 0;
        const indent = depth > 0 ? `${"  ".repeat(depth)}└─ ` : "";
        let depSuffix = "";
        if (depsStatusMap) {
          const depInfo = depsStatusMap.get(task.id);
          if (depInfo && depInfo.blockedBy.length > 0) {
            depSuffix = ` ← BLOCKED by ${depInfo.blockedBy.join(", ")}`;
          }
        }
        lines.push(`${indent}${task.id}: ${task.title} [${task.status}]${depSuffix}`);
      }
      return {
        success: true,
        count: tasks.length,
        output: lines.join("\n"),
      };
    }

    return this.formatResult(
      {
        success: true,
        count: tasks.length,
        tasks,
        message: `Found ${tasks.length} tasks`,
      },
      false
    );
  }
}

/**
 * Task get command implementation
 */
export class TasksGetCommand extends BaseTaskCommand<TasksGetParams> {
  readonly id = "tasks.get";
  readonly name = "get";
  readonly description = "Get details of a specific task";
  readonly parameters = tasksGetParams;

  constructor(private readonly getPersistenceProvider: () => PersistenceProvider) {
    super();
  }

  async execute(params: TasksGetParams, ctx: CommandExecutionContext) {
    const startTime = Date.now();
    this.debug("Starting tasks.get execution", { params, context: ctx });

    try {
      // Validate and normalize task ID
      this.debug("Validating task ID");
      const taskId = this.validateRequired(params.taskId, "taskId");
      const validatedTaskId = this.validateAndNormalizeTaskId(taskId);
      this.debug("Task ID validated and normalized", { taskId, validatedTaskId });

      // Get task details
      this.debug("About to call getTaskFromParams");
      const { getTaskFromParams } = await import("../../../../domain/tasks");
      const taskParams = {
        ...this.createTaskParams(params),
        taskId: validatedTaskId,
      };
      this.debug("Created task params", { taskParams });

      const task = await getTaskFromParams(taskParams, {
        persistenceProvider: this.getPersistenceProvider(),
      });
      this.debug("Task retrieved successfully", { task: task?.id || "unknown" });

      // Enrich with subtask summary if requested and this task has children
      let subtaskSummary:
        | {
            total: number;
            done: number;
            remaining: Array<{ id: string; title: string; status: string }>;
          }
        | undefined;

      if (params.includeSubtasks) {
        try {
          const persistence = this.getPersistenceProvider();
          const db = (await persistence.getDatabaseConnection?.()) as PostgresJsDatabase;
          const { TaskGraphService } = await import("../../../../domain/tasks/task-graph-service");
          const service = new TaskGraphService(db);
          const childIds = await service.listChildren(validatedTaskId);

          if (childIds.length > 0) {
            const { createConfiguredTaskService } = await import(
              "../../../../domain/tasks/taskService"
            );
            const { resolveRepoPath } = await import(
              "../../../../domain/tasks/commands/shared-helpers"
            );
            const taskBaseParams = this.createTaskParams(params);
            const workspacePath = await resolveRepoPath({
              session: taskBaseParams.session as string | undefined,
              repo: taskBaseParams.repo as string | undefined,
            });
            const childTaskService = await createConfiguredTaskService({
              workspacePath,
              backend: taskBaseParams.backend as string | undefined,
              persistenceProvider: persistence,
            });
            const childTasks = await childTaskService.getTasks(childIds);

            // Build a map for quick lookup; unresolved IDs fall back to "(unknown)"
            const childTaskMap = new Map(childTasks.map((t) => [t.id, t]));

            const remaining: Array<{ id: string; title: string; status: string }> = [];
            let doneCount = 0;
            for (const childId of childIds) {
              const childTask = childTaskMap.get(childId);
              if (childTask) {
                if (childTask.status === "DONE" || childTask.status === "CLOSED") {
                  doneCount++;
                } else {
                  remaining.push({
                    id: childTask.id,
                    title: childTask.title,
                    status: childTask.status,
                  });
                }
              } else {
                remaining.push({ id: childId, title: "(unknown)", status: "UNKNOWN" });
              }
            }
            subtaskSummary = { total: childIds.length, done: doneCount, remaining };
          }
        } catch {
          // Graph service unavailable, skip subtask enrichment
        }
      }

      // Build result with optional subtask info
      const extras: Record<string, unknown> = { task };
      if (subtaskSummary) {
        extras.subtasks = subtaskSummary;
      }

      // Optionally fetch spec content
      if (params.includeSpec) {
        const { getTaskSpecContentFromParams } = await import("../../../../domain/tasks");
        try {
          const specResult = await getTaskSpecContentFromParams(
            { ...this.createTaskParams(params), taskId: validatedTaskId },
            { persistenceProvider: this.getPersistenceProvider() }
          );
          extras.spec = specResult.content;
        } catch {
          extras.spec = "";
        }
      }

      let message = `Task ${validatedTaskId} retrieved`;
      if (subtaskSummary) {
        message += `\n\nSubtasks: ${subtaskSummary.done} of ${subtaskSummary.total} done`;
        if (subtaskSummary.remaining.length > 0) {
          message += `\nRemaining:`;
          for (const sub of subtaskSummary.remaining) {
            message += `\n  ${sub.id}: ${sub.title} [${sub.status}]`;
          }
        }
      }
      if (params.includeSpec && extras.spec !== undefined) {
        message += extras.spec ? `\n\nSpec:\n${extras.spec}` : `\n\nSpec: (not found)`;
      }

      const result = this.formatResult(
        this.createSuccessResult(validatedTaskId, message, extras),
        params.json
      );

      const duration = Date.now() - startTime;
      this.debug("tasks.get execution completed", { duration });
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.debug("tasks.get execution failed", {
        error: error instanceof Error ? error.message : String(error),
        duration,
      });
      throw error;
    }
  }
}

/**
 * Task create command implementation
 */
export class TasksCreateCommand extends BaseTaskCommand<TasksCreateParams> {
  readonly id = "tasks.create";
  readonly name = "create";
  readonly description = "Create a new task";
  readonly parameters = tasksCreateParams;

  constructor(private readonly getPersistenceProvider: () => PersistenceProvider) {
    super();
  }

  async execute(params: TasksCreateParams, ctx: CommandExecutionContext) {
    this.debug("Starting tasks.create execution");

    try {
      // Validate required parameters
      this.validateRequired(params.title, "title");

      // Resolve spec content: prefer params.spec, fall back to deprecated params.description
      const specContent = params.spec || params.description;

      // Validate that spec content is provided
      if (!specContent) {
        throw new ValidationError("--spec must be provided");
      }

      // Normalize tag param to string array for domain layer
      const tags = params.tag ? (Array.isArray(params.tag) ? params.tag : [params.tag]) : undefined;

      // Validate tags don't use reserved minsky: prefix
      if (tags) {
        const invalidTags = tags.filter((t) => t.startsWith("minsky:"));
        if (invalidTags.length > 0) {
          throw new ValidationError(
            `Tags cannot use the reserved "minsky:" prefix: ${invalidTags.join(", ")}`
          );
        }
      }

      // Create the task using the same function as main branch
      const { createTaskFromTitleAndSpec } = await import("../../../../domain/tasks");
      const result = await createTaskFromTitleAndSpec(
        {
          title: params.title,
          spec: specContent, // spec content (or deprecated description alias)
          force: params.force ?? false,
          backend: params.backend,
          repo: params.repo,
          workspace: params.workspace,
          session: params.session,
          githubRepo: params.githubRepo,
          tags,
        },
        { persistenceProvider: this.getPersistenceProvider() }
      );

      this.debug("Task created successfully");

      // Handle dependsOn: add dependency edges after task creation
      const depsAdded: string[] = [];
      const depsWarnings: string[] = [];
      if (params.dependsOn) {
        const deps = Array.isArray(params.dependsOn) ? params.dependsOn : [params.dependsOn];
        try {
          const persistence = this.getPersistenceProvider();
          const db = (await persistence.getDatabaseConnection?.()) as PostgresJsDatabase;
          const { TaskGraphService } = await import(
            "../../../../domain/tasks/task-graph-service"
          );
          const service = new TaskGraphService(db);
          for (const dep of deps) {
            try {
              await service.addDependency(result.id, dep);
              depsAdded.push(dep);
            } catch (depErr) {
              const msg = getErrorMessage(depErr);
              depsWarnings.push(`Failed to add dependency ${dep}: ${msg}`);
              log.warn(`[tasks.create] Failed to add dependency ${dep}: ${msg}`);
            }
          }
        } catch (providerErr) {
          const msg = getErrorMessage(providerErr);
          depsWarnings.push(`Could not connect to persistence for dependencies: ${msg}`);
          log.warn(`[tasks.create] Could not connect to persistence for dependencies: ${msg}`);
        }
      }

      // Handle parent: set parent-child relationship after task creation
      let parentSet = false;
      const parentWarnings: string[] = [];
      if (params.parent) {
        try {
          const persistence = this.getPersistenceProvider();
          const db = (await persistence.getDatabaseConnection?.()) as PostgresJsDatabase;
          const { TaskGraphService } = await import(
            "../../../../domain/tasks/task-graph-service"
          );
          const service = new TaskGraphService(db);
          await service.addParent(result.id, params.parent);
          parentSet = true;
        } catch (parentErr) {
          const msg = getErrorMessage(parentErr);
          parentWarnings.push(`Failed to set parent ${params.parent}: ${msg}`);
          log.warn(`[tasks.create] Failed to set parent ${params.parent}: ${msg}`);
        }
      }

      // Fire-and-forget embedding indexing for the newly created task
      autoIndexTaskEmbedding(result.id, { getPersistenceProvider: this.getPersistenceProvider });

      // Build success message
      let message = `Task ${result.id} created: "${result.title}"`;
      if (!params.json) {
        const { default: chalk } = await import("chalk");
        message = chalk.green(`✅ Task ${result.id} created successfully`);
        message += `\n${chalk.gray("  Title: ")}${result.title}`;
        message += `\n${chalk.gray("  ID: ")}${result.id}`;
        if (tags && tags.length > 0) {
          message += `\n${chalk.gray("  Tags: ")}${tags.join(", ")}`;
        }
        if (parentSet) {
          message += `\n${chalk.gray("  Parent: ")}${params.parent}`;
        }
        if (depsAdded.length > 0) {
          message += `\n${chalk.gray("  Depends on: ")}${depsAdded.join(", ")}`;
        }
        for (const warning of depsWarnings) {
          message += `\n${chalk.yellow(`  ⚠️  ${warning}`)}`;
        }
        for (const warning of parentWarnings) {
          message += `\n${chalk.yellow(`  ⚠️  ${warning}`)}`;
        }
      }

      return this.formatResult(
        this.createSuccessResult(result.id, message, {
          task: result,
          ...(depsAdded.length > 0 && { depsAdded }),
          ...(depsWarnings.length > 0 && { depsWarnings }),
        }),
        params.json
      );
    } catch (error) {
      this.debug(`Task creation failed: ${getErrorMessage(error)}`);

      // Ensure non-zero exit code
      process.exitCode = 1;

      // Build actionable error message
      if (!params.json) {
        const { default: chalk } = await import("chalk");
        const errorMsg = getErrorMessage(error);
        let errorMessage = chalk.red(`❌ Failed to create task: ${errorMsg}`);

        if (errorMsg.includes("spec from file")) {
          errorMessage += `\n${chalk.yellow(
            "   Tip: Check that the file exists and you have read permissions."
          )}`;
        }

        const formattedError = new Error(errorMessage);
        formattedError.stack = error instanceof Error ? error.stack : undefined;
        throw formattedError;
      }

      throw error;
    }
  }
}

/**
 * Task delete command implementation
 */
export class TasksDeleteCommand extends BaseTaskCommand<TasksDeleteParams> {
  readonly id = "tasks.delete";
  readonly name = "delete";
  readonly description = "Delete a task";
  readonly parameters = tasksDeleteParams;

  constructor(private readonly getPersistenceProvider: () => PersistenceProvider) {
    super();
  }

  async execute(params: TasksDeleteParams, ctx: CommandExecutionContext) {
    this.debug("Starting tasks.delete execution");

    // Validate and normalize task ID
    const taskId = this.validateRequired(params.taskId, "taskId");
    const validatedTaskId = this.validateAndNormalizeTaskId(taskId);

    // If not forced, prompt for confirmation
    if (!params.force) {
      await this.confirmDeletion(validatedTaskId, params);
    }

    // Delete the task
    const { deleteTaskFromParams } = await import("../../../../domain/tasks");
    const result = await deleteTaskFromParams(
      {
        ...this.createTaskParams(params),
        taskId: validatedTaskId,
        force: params.force ?? false,
      },
      { persistenceProvider: this.getPersistenceProvider() }
    );

    // Clean up parent-child edges for the deleted task (D7: orphan children)
    if (result.success) {
      try {
        const persistence = this.getPersistenceProvider();
        const db = (await persistence.getDatabaseConnection?.()) as PostgresJsDatabase;
        const { TaskGraphService } = await import("../../../../domain/tasks/task-graph-service");
        const service = new TaskGraphService(db);

        // Remove this task's parent edge (if it was a child)
        await service.removeParent(validatedTaskId);

        // Orphan any children by removing their parent edges pointing to this task
        const children = await service.listChildren(validatedTaskId);
        for (const childId of children) {
          await service.removeParent(childId);
        }
      } catch {
        // Graph cleanup is best-effort; don't fail the delete
        log.warn(`[tasks.delete] Could not clean up parent-child edges for ${validatedTaskId}`);
      }
    }

    const message = result.success
      ? `Task ${validatedTaskId} deleted successfully`
      : `Failed to delete task ${validatedTaskId}`;

    this.debug("Task deletion completed");

    return this.formatResult(
      {
        success: result.success,
        taskId: validatedTaskId,
        message,
      },
      params.json
    );
  }

  /**
   * Confirm task deletion with user
   */
  private async confirmDeletion(taskId: string, params: TasksDeleteParams): Promise<void> {
    // Get task details for confirmation
    const { getTaskFromParams } = await import("../../../../domain/tasks");
    const task = await getTaskFromParams(
      {
        ...this.createTaskParams(params),
        taskId,
      },
      { persistenceProvider: this.getPersistenceProvider() }
    );

    // Guard against null task to avoid accessing properties on null
    if (!task) {
      throw new ResourceNotFoundError(`Task ${taskId} not found`, "task", taskId);
    }

    // Import confirm from @clack/prompts for confirmation
    const { confirm, isCancel } = await import("@clack/prompts");

    const shouldDelete = await confirm({
      message: `Are you sure you want to delete task ${task.id}: "${task.title}"?`,
    });

    if (isCancel(shouldDelete) || !shouldDelete) {
      throw new Error("Task deletion cancelled");
    }
  }
}

/**
 * Factory functions for creating command instances
 */
export const createTasksListCommand = (
  getPersistenceProvider: () => PersistenceProvider
): TasksListCommand => new TasksListCommand(getPersistenceProvider);

export const createTasksGetCommand = (
  getPersistenceProvider: () => PersistenceProvider
): TasksGetCommand => new TasksGetCommand(getPersistenceProvider);

export const createTasksCreateCommand = (
  getPersistenceProvider: () => PersistenceProvider
): TasksCreateCommand => new TasksCreateCommand(getPersistenceProvider);

export const createTasksDeleteCommand = (
  getPersistenceProvider: () => PersistenceProvider
): TasksDeleteCommand => new TasksDeleteCommand(getPersistenceProvider);

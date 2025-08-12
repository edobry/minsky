/**
 * Base Task Operation
 *
 * Abstract base class providing common functionality for all task operations.
 * Extracted from taskCommands.ts as part of modularization effort.
 */
import { z } from "zod";
import { resolveRepoPath } from "../../repo-utils";
import { resolveMainWorkspacePath } from "../../workspace";
import { ValidationError, ResourceNotFoundError } from "../../../errors/index";
// normalizeTaskId removed: strict qualified IDs expected upstream
import { createTaskIdParsingErrorMessage } from "../../../errors/enhanced-error-templates";
import { createConfiguredTaskService, TaskService, TaskServiceOptions } from "../taskService";

/**
 * Common dependencies for task operations
 */
export interface TaskOperationDependencies {
  resolveRepoPath: typeof resolveRepoPath;
  resolveMainWorkspacePath: typeof resolveMainWorkspacePath;
  createTaskService: (options: TaskServiceOptions) => Promise<TaskService>;
}

/**
 * Default dependencies for task operations
 */
export const defaultTaskOperationDependencies: TaskOperationDependencies = {
  resolveRepoPath,
  resolveMainWorkspacePath,
  createTaskService: async (options) => await createConfiguredTaskService(options),
};

/**
 * Common parameters for task operations
 */
export interface BaseTaskOperationParams {
  taskId?: string;
  repo?: string;
  session?: string;
  workspace?: string;
  backend?: string;
}

/**
 * Abstract base class for task operations
 */
export abstract class BaseTaskOperation<TParams, TResult> {
  constructor(protected deps: TaskOperationDependencies = defaultTaskOperationDependencies) {}

  /**
   * Get the Zod schema for validating parameters
   */
  abstract getSchema(): z.ZodSchema<TParams>;

  /**
   * Execute the operation with validated parameters
   */
  abstract executeOperation(params: TParams): Promise<TResult>;

  /**
   * Get the operation name (for error messages)
   */
  abstract getOperationName(): string;

  /**
   * Execute the operation with full validation and error handling
   */
  async execute(params: TParams): Promise<TResult> {
    try {
      // Validate parameters
      const validParams = await this.validateParams(params);

      // Execute the operation
      return await this.executeOperation(validParams);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ValidationError(
          `Invalid parameters for ${this.getOperationName()}`,
          error.format(),
          error
        );
      }
      throw error;
    }
  }

  /**
   * Validate parameters and normalize task ID if present
   */
  protected async validateParams(params: TParams): Promise<TParams> {
    // Validate directly (strict qualified IDs expected)
    return this.getSchema().parse(params);
  }

  /**
   * Resolve workspace path
   */
  protected async resolveWorkspacePath(params: BaseTaskOperationParams): Promise<string> {
    return await this.deps.resolveMainWorkspacePath();
  }

  /**
   * Create task service with proper configuration
   */
  protected async createTaskService(
    params: BaseTaskOperationParams,
    workspacePath: string
  ): Promise<TaskService> {
    return await this.deps.createTaskService({
      workspacePath,
      backend: params.backend || "markdown", // Use markdown as default to avoid config lookup
    });
  }

  /**
   * Get a task and verify it exists
   */
  protected async getTaskAndVerifyExists(taskService: TaskService, taskId: string): Promise<any> {
    const task = await taskService.getTask(taskId);

    if (!task) {
      throw new ResourceNotFoundError(`Task ${taskId} not found`, "task", taskId);
    }

    return task;
  }

  /**
   * Common setup for operations that need workspace and task service
   */
  protected async setupWorkspaceAndService(
    params: BaseTaskOperationParams
  ): Promise<{ workspacePath: string; taskService: TaskService }> {
    // First get the repo path (needed for workspace resolution)
    const repoPath = await this.deps.resolveRepoPath({
      session: params.session,
      repo: params.repo,
    });

    // Then get the workspace path
    const workspacePath = await this.resolveWorkspacePath(params);

    // Create task service
    const taskService = await this.createTaskService(params, workspacePath);

    return { workspacePath, taskService };
  }
}

/**
 * Factory type for creating task operations
 */
export type TaskOperationFactory<TParams, TResult> = (
  deps?: TaskOperationDependencies
) => BaseTaskOperation<TParams, TResult>;

/**
 * Task operation registry for managing operation instances
 */
export class TaskOperationRegistry {
  private operations = new Map<string, BaseTaskOperation<any, any>>();

  /**
   * Register a task operation
   */
  register<TParams, TResult>(name: string, operation: BaseTaskOperation<TParams, TResult>): void {
    this.operations.set(name, operation);
  }

  /**
   * Get a task operation by name
   */
  get<TParams, TResult>(name: string): BaseTaskOperation<TParams, TResult> | undefined {
    return this.operations.get(name);
  }

  /**
   * Execute an operation by name
   */
  async execute<TParams, TResult>(name: string, params: TParams): Promise<TResult> {
    const operation = this.get<TParams, TResult>(name);
    if (!operation) {
      throw new ValidationError(`Task operation '${name}' not found`);
    }
    return await operation.execute(params);
  }

  /**
   * Get all registered operation names
   */
  getOperationNames(): string[] {
    return Array.from(this.operations.keys());
  }

  /**
   * Clear all operations (useful for testing)
   */
  clear(): void {
    this.operations.clear();
  }
}

/**
 * Default task operation registry instance
 */
export const taskOperationRegistry = new TaskOperationRegistry();

/**
 * Modular Task Commands
 *
 * Lightweight orchestration layer that coordinates the extracted task operation components.
 * This replaces the monolithic taskCommands.ts with a modular, operation-pattern architecture.
 */
import {
  createAllTaskOperations,
  setupTaskOperationRegistry,
  type TaskOperationDependencies,
  type TaskOperationRegistry,
} from "./operations";
import {
  type TaskListParams,
  type TaskGetParams,
  type TaskStatusGetParams,
  type TaskStatusSetParams,
  type TaskCreateParams,
  type TaskCreateFromTitleAndDescriptionParams,
  type TaskSpecContentParams,
  type TaskDeleteParams,
} from "../../schemas/tasks";

/**
 * Modular Task Commands Manager
 *
 * Manages task operations using the Strategy Pattern with dependency injection.
 * Provides a clean interface for executing task operations.
 */
export class ModularTaskCommandsManager {
  private operations: ReturnType<typeof createAllTaskOperations>;
  private operationRegistry: TaskOperationRegistry;

  constructor(deps?: TaskOperationDependencies) {
    this.operations = createAllTaskOperations(deps);
    this.operationRegistry = setupTaskOperationRegistry(deps);
  }

  /**
   * List tasks using the provided parameters
   */
  async listTasksFromParams(params: TaskListParams): Promise<any[]> {
    return await this.operations.listTasks.execute(params);
  }

  /**
   * Get a task by ID using the provided parameters
   */
  async getTaskFromParams(params: TaskGetParams): Promise<any> {
    return await this.operations.getTask.execute(params);
  }

  /**
   * Get task status using the provided parameters
   */
  async getTaskStatusFromParams(params: TaskStatusGetParams): Promise<string> {
    return await this.operations.getTaskStatus.execute(params);
  }

  /**
   * Set task status using the provided parameters
   */
  async setTaskStatusFromParams(params: TaskStatusSetParams): Promise<any> {
    return await this.operations.setTaskStatus.execute(params);
  }

  /**
   * Create task using the provided parameters
   */
  async createTaskFromParams(params: TaskCreateParams): Promise<any> {
    return await this.operations.createTask.execute(params);
  }

  /**
   * Create task from title and description
   */
  async createTaskFromTitleAndDescription(
    title: string,
    description?: string,
    options: Partial<TaskCreateFromTitleAndDescriptionParams> = {}
  ): Promise<any> {
    const params: TaskCreateFromTitleAndDescriptionParams = {
      title,
      description,
      ...options,
    };
    return await this.operations.createTaskFromTitleAndDescription.execute(params);
  }

  /**
   * Get task specification content using the provided parameters
   */
  async getTaskSpecContentFromParams(params: TaskSpecContentParams): Promise<string> {
    return await this.operations.getTaskSpecContent.execute(params);
  }

  /**
   * Delete task using the provided parameters
   */
  async deleteTaskFromParams(params: TaskDeleteParams): Promise<any> {
    return await this.operations.deleteTask.execute(params);
  }

  /**
   * Execute operation by name (registry-based execution)
   */
  async executeOperation<TParams, TResult>(
    operationName: string,
    params: TParams
  ): Promise<TResult> {
    return await this.operationRegistry.execute<TParams, TResult>(operationName, params);
  }

  /**
   * Get available operation names
   */
  getOperationNames(): string[] {
    return this.operationRegistry.getOperationNames();
  }

  /**
   * Get the operation registry
   */
  getOperationRegistry(): TaskOperationRegistry {
    return this.operationRegistry;
  }

  /**
   * Get direct access to operations (for advanced usage)
   */
  getOperations() {
    return this.operations;
  }
}

/**
 * Default modular task commands manager instance
 */
export const modularTaskCommandsManager = new ModularTaskCommandsManager();

/**
 * Factory function to create a task commands manager with custom dependencies
 */
export function createModularTaskCommandsManager(
  deps?: TaskOperationDependencies
): ModularTaskCommandsManager {
  return new ModularTaskCommandsManager(deps);
}

// Backward compatibility functions that delegate to the modular manager

/**
 * List tasks using the provided parameters (backward compatibility)
 */
export async function listTasksFromParams(
  params: TaskListParams,
  deps?: TaskOperationDependencies
): Promise<any[]> {
  const manager = deps ? createModularTaskCommandsManager(deps) : modularTaskCommandsManager;
  return await manager.listTasksFromParams(params);
}

/**
 * Get a task by ID using the provided parameters (backward compatibility)
 */
export async function getTaskFromParams(
  params: TaskGetParams,
  deps?: TaskOperationDependencies
): Promise<any> {
  const manager = deps ? createModularTaskCommandsManager(deps) : modularTaskCommandsManager;
  return await manager.getTaskFromParams(params);
}

/**
 * Get task status using the provided parameters (backward compatibility)
 */
export async function getTaskStatusFromParams(
  params: TaskStatusGetParams,
  deps?: TaskOperationDependencies
): Promise<string> {
  const manager = deps ? createModularTaskCommandsManager(deps) : modularTaskCommandsManager;
  return await manager.getTaskStatusFromParams(params);
}

/**
 * Set task status using the provided parameters (backward compatibility)
 */
export async function setTaskStatusFromParams(
  params: TaskStatusSetParams,
  deps?: TaskOperationDependencies
): Promise<any> {
  const manager = deps ? createModularTaskCommandsManager(deps) : modularTaskCommandsManager;
  return await manager.setTaskStatusFromParams(params);
}

/**
 * Create task using the provided parameters (backward compatibility)
 */
export async function createTaskFromParams(
  params: TaskCreateParams,
  deps?: TaskOperationDependencies
): Promise<any> {
  const manager = deps ? createModularTaskCommandsManager(deps) : modularTaskCommandsManager;
  return await manager.createTaskFromParams(params);
}

/**
 * Create task from title and description (backward compatibility)
 */
export async function createTaskFromTitleAndDescription(
  title: string,
  description?: string,
  options: Partial<TaskCreateFromTitleAndDescriptionParams> = {},
  deps?: TaskOperationDependencies
): Promise<any> {
  const manager = deps ? createModularTaskCommandsManager(deps) : modularTaskCommandsManager;
  return await manager.createTaskFromTitleAndDescription(title, description, options);
}

/**
 * Get task specification content using the provided parameters (backward compatibility)
 */
export async function getTaskSpecContentFromParams(
  params: TaskSpecContentParams,
  deps?: TaskOperationDependencies
): Promise<string> {
  const manager = deps ? createModularTaskCommandsManager(deps) : modularTaskCommandsManager;
  return await manager.getTaskSpecContentFromParams(params);
}

/**
 * Delete task using the provided parameters (backward compatibility)
 */
export async function deleteTaskFromParams(
  params: TaskDeleteParams,
  deps?: TaskOperationDependencies
): Promise<any> {
  const manager = deps ? createModularTaskCommandsManager(deps) : modularTaskCommandsManager;
  return await manager.deleteTaskFromParams(params);
}

// Re-export types and constants for compatibility
export { TASK_STATUS } from "./taskConstants";
export type { TaskStatus } from "./taskConstants";

// Export all operation components for direct access
export * from "./operations";

// Export for migration path
export { ModularTaskCommandsManager as TaskCommandsManager };
export { modularTaskCommandsManager as taskCommandsManager };
/**
 * Task Operations Module
 *
 * Exports for all modularized task operation components.
 * Part of the modularization effort from taskCommands.ts.
 */

// Base operation infrastructure
export {
  BaseTaskOperation,
  TaskOperationRegistry,
  taskOperationRegistry,
  defaultTaskOperationDependencies,
} from "./base-task-operation";
export type {
  TaskOperationDependencies,
  TaskOperationFactory,
  BaseTaskOperationParams,
} from "./base-task-operation";

// Query operations
export {
  ListTasksOperation,
  GetTaskOperation,
  GetTaskStatusOperation,
  GetTaskSpecContentOperation,
  createListTasksOperation,
  createGetTaskOperation,
  createGetTaskStatusOperation,
  createGetTaskSpecContentOperation,
} from "./query-operations";

// Mutation operations
export {
  SetTaskStatusOperation,
  CreateTaskOperation,
  CreateTaskFromTitleAndDescriptionOperation,
  DeleteTaskOperation,
  createSetTaskStatusOperation,
  createCreateTaskOperation,
  createCreateTaskFromTitleAndDescriptionOperation,
  createDeleteTaskOperation,
} from "./mutation-operations";

// Factory for creating all operations
export function createAllTaskOperations(deps?: TaskOperationDependencies) {
  return {
    // Query operations
    listTasks: createListTasksOperation(deps),
    getTask: createGetTaskOperation(deps),
    getTaskStatus: createGetTaskStatusOperation(deps),
    getTaskSpecContent: createGetTaskSpecContentOperation(deps),

    // Mutation operations
    setTaskStatus: createSetTaskStatusOperation(deps),
    createTask: createCreateTaskOperation(deps),
    createTaskFromTitleAndDescription: createCreateTaskFromTitleAndDescriptionOperation(deps),
    deleteTask: createDeleteTaskOperation(deps),
  };
}

// Registry setup function
export function setupTaskOperationRegistry(
  deps?: TaskOperationDependencies
): TaskOperationRegistry {
  const registry = new TaskOperationRegistry();
  const operations = createAllTaskOperations(deps);

  // Register all operations
  registry.register("listTasks", operations.listTasks);
  registry.register("getTask", operations.getTask);
  registry.register("getTaskStatus", operations.getTaskStatus);
  registry.register("getTaskSpecContent", operations.getTaskSpecContent);
  registry.register("setTaskStatus", operations.setTaskStatus);
  registry.register("createTask", operations.createTask);
  registry.register(
    "createTaskFromTitleAndDescription",
    operations.createTaskFromTitleAndDescription
  );
  registry.register("deleteTask", operations.deleteTask);

  return registry;
}

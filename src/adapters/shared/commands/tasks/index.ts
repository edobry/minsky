/**
 * Task Commands Module
 *
 * Exports for all modularized task command components.
 * Part of the modularization effort from tasks.ts.
 */

// Base command infrastructure
export { BaseTaskCommand, TaskCommandRegistry, taskCommandRegistry } from "./base-task-command";
export type { BaseTaskParams, TaskCommandResult, TaskCommandFactory } from "./base-task-command";

// Parameter definitions
export * from "./task-parameters";

// Command implementations (re-export)
export {
  TasksStatusGetCommand,
  TasksStatusSetCommand,
  createTasksStatusGetCommand,
  createTasksStatusSetCommand,
} from "./status-commands";

export { TasksSpecCommand, createTasksSpecCommand } from "./spec-command";

export {
  TasksListCommand,
  TasksGetCommand,
  TasksCreateCommand,
  TasksDeleteCommand,
  createTasksListCommand,
  createTasksGetCommand,
  createTasksCreateCommand,
  createTasksDeleteCommand,
} from "./crud-commands";

export { MigrateTasksCommand, createMigrateTasksCommand } from "./migrate-command";

// Export registry setup functions from separate module
export { createAllTaskCommands, setupTaskCommandRegistry } from "./registry-setup";

// Similarity commands
export { TasksSimilarCommand, TasksSearchCommand } from "./similarity-commands";

// Index embeddings command
export { TasksIndexEmbeddingsCommand } from "./index-embeddings-command";

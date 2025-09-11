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

// Command implementations (re-export) - DatabaseCommand classes only
export {
  TasksStatusGetCommand,
  TasksStatusSetCommand,
} from "./status-commands";

export { TasksSpecCommand } from "./spec-command";

export {
  TasksListCommand,
  TasksGetCommand,
  TasksCreateCommand,
  TasksDeleteCommand,
} from "./crud-commands";

export { MigrateTasksCommand } from "./migrate-command";
export { TasksMigrateBackendCommand } from "./migrate-backend-command";

export { TasksEditCommand } from "./edit-commands";

export {
  TasksDepsAddCommand,
  TasksDepsRmCommand,
  TasksDepsListCommand,
} from "./deps-commands";

export {
  TasksDepsTreeCommand,
  TasksDepsGraphCommand,
} from "./deps-visualization-commands";

export { TasksAvailableCommand, TasksRouteCommand } from "./routing-commands";

// Export registry setup functions from separate module
export { createAllTaskCommands, setupTaskCommandRegistry } from "./registry-setup";

// Similarity commands
export { TasksSimilarCommand, TasksSearchCommand } from "./similarity-commands";

// Index embeddings command
export { TasksIndexEmbeddingsCommand } from "./index-embeddings-command";

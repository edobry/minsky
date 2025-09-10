/**
 * Task Command Registry Setup
 *
 * Lazy initialization to avoid circular dependencies.
 */
import { TaskCommandRegistry } from "./base-task-command";

let registry: TaskCommandRegistry | null = null;

// Lazy registry setup function
export function setupTaskCommandRegistry() {
  if (!registry) {
    registry = new TaskCommandRegistry();

    // Import and register commands only when needed
    const commands = createAllTaskCommands();
    commands.forEach((command) => {
      registry!.register(command);
    });
  }

  return registry;
}

// Factory function that creates commands when called
export function createAllTaskCommands() {
  // Import command creation functions locally to avoid top-level circular imports
  const { createTasksStatusGetCommand, createTasksStatusSetCommand } = require("./status-commands");
  const { createTasksSpecCommand } = require("./spec-command");
  const {
    createTasksListCommand,
    createTasksGetCommand,
    createTasksCreateCommand,
    createTasksDeleteCommand,
  } = require("./crud-commands");
  const { createTasksEditCommand } = require("./edit-commands");
  const { createMigrateTasksCommand } = require("./migrate-command");
  const { createTasksMigrateBackendCommand } = require("./migrate-backend-command");
  const { TasksSimilarCommand, TasksSearchCommand } = require("./similarity-commands");
  const { TasksIndexEmbeddingsCommand } = require("./index-embeddings-command");
  // Import migrated dependency commands that use DatabaseCommand pattern
  const {
    TasksDepsAddCommand,
    TasksDepsRmCommand, 
    TasksDepsListCommand,
  } = require("./deps-commands-migrated");
  const {
    createTasksDepsTreeCommand,
    createTasksDepsGraphCommand,
  } = require("./deps-visualization-commands");
  // Import migrated routing commands that use DatabaseCommand pattern
  const { TasksAvailableCommand, TasksRouteCommand } = require("./routing-commands-migrated");

  return [
    createTasksStatusGetCommand(),
    createTasksStatusSetCommand(),
    createTasksSpecCommand(),
    createTasksListCommand(),
    createTasksGetCommand(),
    createTasksCreateCommand(),
    createTasksEditCommand(),
    createTasksDeleteCommand(),
    new TasksSimilarCommand(),
    new TasksSearchCommand(),
    new TasksIndexEmbeddingsCommand(),
    createMigrateTasksCommand(),
    createTasksMigrateBackendCommand(),
    // Dependency management commands - MIGRATED to DatabaseCommand pattern
    new TasksDepsAddCommand(),
    new TasksDepsRmCommand(),
    new TasksDepsListCommand(),
    createTasksDepsTreeCommand(),
    createTasksDepsGraphCommand(),
    // Routing commands - MIGRATED to DatabaseCommand pattern
    new TasksAvailableCommand(),
    new TasksRouteCommand(),
  ];
}

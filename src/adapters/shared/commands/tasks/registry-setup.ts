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
    TasksListCommand,
    TasksGetCommand,
    TasksCreateCommand,
    TasksDeleteCommand,
  } = require("./crud-commands-migrated");
  const { createTasksEditCommand } = require("./edit-commands");
  const { createMigrateTasksCommand } = require("./migrate-command");
  const { createTasksMigrateBackendCommand } = require("./migrate-backend-command");
  // Import migrated similarity commands that use DatabaseCommand pattern
  const {
    TasksSimilarCommandMigrated,
    TasksSearchCommandMigrated,
  } = require("./similarity-commands-migrated");
  const { TasksIndexEmbeddingsCommand } = require("./index-embeddings-command-migrated");
  // Import migrated dependency commands that use DatabaseCommand pattern
  const {
    TasksDepsAddCommand,
    TasksDepsRmCommand,
    TasksDepsListCommand,
  } = require("./deps-commands-migrated");
  // Import migrated deps visualization commands that use DatabaseCommand pattern
  const {
    TasksDepsTreeCommand,
    TasksDepsGraphCommand,
  } = require("./deps-visualization-commands-migrated");
  // Import migrated routing commands that use DatabaseCommand pattern
  const { TasksAvailableCommand, TasksRouteCommand } = require("./routing-commands-migrated");

  return [
    createTasksStatusGetCommand(),
    createTasksStatusSetCommand(),
    createTasksSpecCommand(),
    new TasksListCommand(),
    new TasksGetCommand(),
    new TasksCreateCommand(),
    createTasksEditCommand(),
    new TasksDeleteCommand(),
    // Similarity commands - MIGRATED to DatabaseCommand pattern
    new TasksSimilarCommandMigrated(),
    new TasksSearchCommandMigrated(),
    new TasksIndexEmbeddingsCommand(),
    createMigrateTasksCommand(),
    createTasksMigrateBackendCommand(),
    // Dependency management commands - MIGRATED to DatabaseCommand pattern
    new TasksDepsAddCommand(),
    new TasksDepsRmCommand(),
    new TasksDepsListCommand(),
    new TasksDepsTreeCommand(),
    new TasksDepsGraphCommand(),
    // Routing commands - MIGRATED to DatabaseCommand pattern
    new TasksAvailableCommand(),
    new TasksRouteCommand(),
  ];
}

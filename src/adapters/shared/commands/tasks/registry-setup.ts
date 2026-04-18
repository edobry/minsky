/**
 * Task Command Registry Setup
 *
 * Lazy initialization to avoid circular dependencies.
 */
import { TaskCommandRegistry } from "./base-task-command";
import { PersistenceService } from "../../../../domain/persistence/service";

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
  const getPersistenceProvider = () => PersistenceService.getProvider();
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
  const { createTasksMigrateBackendCommand } = require("./migrate-backend-command");
  const { TasksSimilarCommand, TasksSearchCommand } = require("./similarity-commands");
  const { TasksIndexEmbeddingsCommand } = require("./index-embeddings-command");
  const {
    createTasksDepsAddCommand,
    createTasksDepsRmCommand,
    createTasksDepsListCommand,
    createTasksChildrenCommand,
    createTasksParentCommand,
  } = require("./deps-commands");
  const {
    createTasksDepsTreeCommand,
    createTasksDepsGraphCommand,
  } = require("./deps-visualization-commands");
  const { createTasksAvailableCommand, createTasksRouteCommand } = require("./routing-commands");

  return [
    createTasksStatusGetCommand(),
    createTasksStatusSetCommand(),
    createTasksSpecCommand(),
    createTasksListCommand(getPersistenceProvider),
    createTasksGetCommand(),
    createTasksCreateCommand(getPersistenceProvider),
    createTasksEditCommand(),
    createTasksDeleteCommand(getPersistenceProvider),
    new TasksSimilarCommand(),
    new TasksSearchCommand(),
    new TasksIndexEmbeddingsCommand(),
    createTasksMigrateBackendCommand(),
    // Dependency management commands
    createTasksDepsAddCommand(getPersistenceProvider),
    createTasksDepsRmCommand(getPersistenceProvider),
    createTasksDepsListCommand(getPersistenceProvider),
    createTasksDepsTreeCommand(getPersistenceProvider),
    createTasksDepsGraphCommand(getPersistenceProvider),
    // Parent-child (subtask) commands
    createTasksChildrenCommand(getPersistenceProvider),
    createTasksParentCommand(getPersistenceProvider),
    // Routing commands
    createTasksAvailableCommand(getPersistenceProvider),
    createTasksRouteCommand(getPersistenceProvider),
  ];
}

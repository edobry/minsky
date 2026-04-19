/**
 * Task Command Registry Setup
 *
 * Lazy initialization to avoid circular dependencies.
 */
import { TaskCommandRegistry } from "./base-task-command";
import type { AppContainerInterface } from "../../../../composition/types";

let registry: TaskCommandRegistry | null = null;

// Lazy registry setup function
export function setupTaskCommandRegistry(container?: AppContainerInterface) {
  if (!registry) {
    registry = new TaskCommandRegistry();

    // Import and register commands only when needed
    const commands = createAllTaskCommands(container);
    commands.forEach((command) => {
      registry!.register(command);
    });
  }

  return registry;
}

// Factory function that creates commands when called
export function createAllTaskCommands(container?: AppContainerInterface) {
  let cachedPersistence: {
    getProvider: () => import("../../../../domain/persistence/types").PersistenceProvider;
  } | null = null;
  const getPersistenceProvider = () => {
    if (container?.has("persistence")) {
      return container.get("persistence");
    }
    if (!cachedPersistence) {
      cachedPersistence = require("../../../../domain/persistence/service").PersistenceService;
    }
    return cachedPersistence!.getProvider();
  };
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
  const { TasksEmbeddingsStatusCommand } = require("./embeddings-status-command");
  const { TasksEmbeddingsRepairCommand } = require("./embeddings-repair-command");
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
  const { createTasksDispatchCommand } = require("./dispatch-command");

  return [
    createTasksStatusGetCommand(),
    createTasksStatusSetCommand(),
    createTasksSpecCommand(),
    createTasksListCommand(getPersistenceProvider),
    createTasksGetCommand(getPersistenceProvider),
    createTasksCreateCommand(getPersistenceProvider),
    createTasksEditCommand(),
    createTasksDeleteCommand(getPersistenceProvider),
    new TasksSimilarCommand(),
    new TasksSearchCommand(),
    new TasksIndexEmbeddingsCommand(),
    new TasksEmbeddingsStatusCommand(),
    new TasksEmbeddingsRepairCommand(),
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
    // Dispatch (subtask + session + prompt in one call)
    createTasksDispatchCommand(getPersistenceProvider),
  ];
}

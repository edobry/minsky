/**
 * Modular Tasks Commands
 *
 * Lightweight replacement for the original tasks commands using the Command Pattern.
 * This reduces duplication and improves maintainability by creating commands on-demand.
 */
import { sharedCommandRegistry, defineCommand } from "../command-registry";
import { CommandCategory } from "../command-registry";
import { log } from "../../../utils/logger";
import { PersistenceService } from "../../../domain/persistence/service";
import {
  createTasksListCommand,
  createTasksGetCommand,
  createTasksCreateCommand,
  createTasksDeleteCommand,
} from "./tasks/crud-commands";
import { createTasksSpecCommand } from "./tasks/spec-command";
import { createTasksStatusGetCommand, createTasksStatusSetCommand } from "./tasks/status-commands";
import { createTasksEditCommand } from "./tasks/edit-commands";
import { createTasksMigrateBackendCommand } from "./tasks/migrate-backend-command";
import { TasksSimilarCommand, TasksSearchCommand } from "./tasks/similarity-commands";
import { TasksIndexEmbeddingsCommand } from "./tasks/index-embeddings-command";
import {
  createTasksDepsAddCommand,
  createTasksDepsRmCommand,
  createTasksDepsListCommand,
} from "./tasks/deps-commands";
import {
  createTasksDepsTreeCommand,
  createTasksDepsGraphCommand,
} from "./tasks/deps-visualization-commands";
import { createTasksAvailableCommand, createTasksRouteCommand } from "./tasks/routing-commands";

/**
 * Modular Tasks Command Manager
 *
 * Manages task commands using the Command Pattern with lazy loading.
 * Commands are created on-demand to avoid circular dependencies.
 */
export class ModularTasksCommandManager {
  /**
   * Register all task commands in the shared command registry
   */
  registerAllCommands(): void {
    // Register all tasks commands using static imports
    try {
      log.debug("[ModularTasksCommandManager] Starting registerAllCommands");

      // Create command instances to get their parameter definitions
      log.debug("[ModularTasksCommandManager] Creating command instances");
      const listCommand = createTasksListCommand();
      const getCommand = createTasksGetCommand();
      const createCommand = createTasksCreateCommand();
      const editCommand = createTasksEditCommand();
      const deleteCommand = createTasksDeleteCommand();
      const specCommand = createTasksSpecCommand();
      const statusGetCommand = createTasksStatusGetCommand();
      const statusSetCommand = createTasksStatusSetCommand();
      const migrateBackendCommand = createTasksMigrateBackendCommand();

      const similarCommand = new TasksSimilarCommand();
      const searchCommand = new TasksSearchCommand();
      const indexEmbeddingsCommand = new TasksIndexEmbeddingsCommand();

      const getPersistenceProvider = () => PersistenceService.getProvider();
      const depsAddCommand = createTasksDepsAddCommand(getPersistenceProvider);
      const depsRmCommand = createTasksDepsRmCommand(getPersistenceProvider);
      const depsListCommand = createTasksDepsListCommand(getPersistenceProvider);
      const depsTreeCommand = createTasksDepsTreeCommand(getPersistenceProvider);
      const depsGraphCommand = createTasksDepsGraphCommand(getPersistenceProvider);

      const availableCommand = createTasksAvailableCommand(getPersistenceProvider);
      const routeCommand = createTasksRouteCommand(getPersistenceProvider);

      // Register list command
      sharedCommandRegistry.registerCommand(
        defineCommand({
          id: "tasks.list",
          category: CommandCategory.TASKS,
          name: "list",
          description: "List tasks",
          parameters: listCommand.parameters,
          execute: async (params, context) => {
            return await listCommand.execute(params, context);
          },
        })
      );

      // Register get command
      sharedCommandRegistry.registerCommand(
        defineCommand({
          id: "tasks.get",
          category: CommandCategory.TASKS,
          name: "get",
          description: "Get task details",
          parameters: getCommand.parameters,
          execute: async (params, context) => {
            return await getCommand.execute(params, context);
          },
        })
      );

      // Register create command
      sharedCommandRegistry.registerCommand(
        defineCommand({
          id: "tasks.create",
          category: CommandCategory.TASKS,
          name: "create",
          description: "Create a new task",
          parameters: createCommand.parameters,
          execute: async (params, context) => {
            return await createCommand.execute(params, context);
          },
        })
      );

      // Register edit command
      sharedCommandRegistry.registerCommand(
        defineCommand({
          id: "tasks.edit",
          category: CommandCategory.TASKS,
          name: "edit",
          description: "Edit task title and/or specification content",
          parameters: editCommand.parameters,
          execute: async (params, context) => {
            return await editCommand.execute(params, context);
          },
        })
      );

      // Register delete command
      sharedCommandRegistry.registerCommand(
        defineCommand({
          id: "tasks.delete",
          category: CommandCategory.TASKS,
          name: "delete",
          description: "Delete a task",
          parameters: deleteCommand.parameters,
          execute: async (params, context) => {
            return await deleteCommand.execute(params, context);
          },
        })
      );

      // Register spec get command
      sharedCommandRegistry.registerCommand(
        defineCommand({
          id: "tasks.spec.get",
          category: CommandCategory.TASKS,
          name: "get",
          description: "Get task specification content",
          parameters: specCommand.parameters,
          execute: async (params, context) => {
            return await specCommand.execute(params, context);
          },
        })
      );

      // Register spec edit command
      sharedCommandRegistry.registerCommand(
        defineCommand({
          id: "tasks.spec.edit",
          category: CommandCategory.TASKS,
          name: "edit",
          description: "Edit task specification content",
          parameters: editCommand.parameters,
          execute: async (params, context) => {
            // For spec edit, we only allow spec-related parameters
            const specParams = {
              ...params,
              title: undefined, // Don't allow title editing in spec edit
            };
            return await editCommand.execute(specParams, context);
          },
        })
      );

      // Register status get command
      sharedCommandRegistry.registerCommand(
        defineCommand({
          id: "tasks.status.get",
          category: CommandCategory.TASKS,
          name: "get",
          description: "Get the status of a task",
          parameters: statusGetCommand.parameters,
          execute: async (params, context) => {
            return await statusGetCommand.execute(params, context);
          },
        })
      );

      // Register status set command
      sharedCommandRegistry.registerCommand(
        defineCommand({
          id: "tasks.status.set",
          category: CommandCategory.TASKS,
          name: "set",
          description: "Set the status of a task",
          parameters: statusSetCommand.parameters,
          execute: async (params, context) => {
            return await statusSetCommand.execute(params, context);
          },
        })
      );

      // Register migrate-backend command
      sharedCommandRegistry.registerCommand(
        defineCommand({
          id: "tasks.migrate-backend",
          category: CommandCategory.TASKS,
          name: "migrate-backend",
          description: "Migrate tasks between different backends (minsky, github)",
          parameters: migrateBackendCommand.parameters,
          execute: async (params, context) => {
            return await migrateBackendCommand.execute(params, context);
          },
        })
      );

      // Register similarity commands
      sharedCommandRegistry.registerCommand(
        defineCommand({
          id: similarCommand.id,
          category: CommandCategory.TASKS,
          name: similarCommand.name,
          description: similarCommand.description,
          parameters: similarCommand.parameters,
          execute: (params, ctx) =>
            similarCommand.execute(
              params as Parameters<typeof similarCommand.execute>[0],
              ctx as Parameters<typeof similarCommand.execute>[1]
            ),
        })
      );

      sharedCommandRegistry.registerCommand(
        defineCommand({
          id: searchCommand.id,
          category: CommandCategory.TASKS,
          name: searchCommand.name,
          description: searchCommand.description,
          parameters: searchCommand.parameters,
          execute: (params, ctx) =>
            searchCommand.execute(
              params as Parameters<typeof searchCommand.execute>[0],
              ctx as Parameters<typeof searchCommand.execute>[1]
            ),
        })
      );

      // Register index embeddings command
      sharedCommandRegistry.registerCommand(
        defineCommand({
          id: indexEmbeddingsCommand.id,
          category: CommandCategory.TASKS,
          name: indexEmbeddingsCommand.name,
          description: indexEmbeddingsCommand.description,
          parameters: indexEmbeddingsCommand.parameters,
          execute: (params, ctx) =>
            indexEmbeddingsCommand.execute(
              params as Parameters<typeof indexEmbeddingsCommand.execute>[0],
              ctx as Parameters<typeof indexEmbeddingsCommand.execute>[1]
            ),
        })
      );

      // Register deps commands using the command objects directly
      sharedCommandRegistry.registerCommand({
        id: depsAddCommand.id,
        category: CommandCategory.TASKS,
        name: depsAddCommand.name,
        description: depsAddCommand.description,
        parameters: depsAddCommand.parameters,
        execute: depsAddCommand.execute,
      });

      sharedCommandRegistry.registerCommand({
        id: depsRmCommand.id,
        category: CommandCategory.TASKS,
        name: depsRmCommand.name,
        description: depsRmCommand.description,
        parameters: depsRmCommand.parameters,
        execute: depsRmCommand.execute,
      });

      sharedCommandRegistry.registerCommand({
        id: depsListCommand.id,
        category: CommandCategory.TASKS,
        name: depsListCommand.name,
        description: depsListCommand.description,
        parameters: depsListCommand.parameters,
        execute: depsListCommand.execute,
      });

      sharedCommandRegistry.registerCommand({
        id: depsTreeCommand.id,
        category: CommandCategory.TASKS,
        name: depsTreeCommand.name,
        description: depsTreeCommand.description,
        parameters: depsTreeCommand.parameters,
        execute: depsTreeCommand.execute,
      });

      sharedCommandRegistry.registerCommand({
        id: depsGraphCommand.id,
        category: CommandCategory.TASKS,
        name: depsGraphCommand.name,
        description: depsGraphCommand.description,
        parameters: depsGraphCommand.parameters,
        execute: depsGraphCommand.execute,
      });

      // Register routing commands
      sharedCommandRegistry.registerCommand({
        id: availableCommand.id,
        category: CommandCategory.TASKS,
        name: availableCommand.name,
        description: availableCommand.description,
        parameters: availableCommand.parameters,
        execute: availableCommand.execute,
      });

      sharedCommandRegistry.registerCommand({
        id: routeCommand.id,
        category: CommandCategory.TASKS,
        name: routeCommand.name,
        description: routeCommand.description,
        parameters: routeCommand.parameters,
        execute: routeCommand.execute,
      });
    } catch (error) {
      log.warn(
        `Failed to register task commands: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get a specific task command by ID
   */
  getCommand(commandId: string) {
    log.warn("getCommand is deprecated. Commands are created on-demand.");
    return null;
  }

  /**
   * Get all registered task commands
   */
  getAllCommands() {
    log.warn("getAllCommands is deprecated. Commands are created on-demand.");
    return [];
  }

  /**
   * Get all task command registrations for the shared registry
   */
  getAllRegistrations() {
    log.warn("getAllRegistrations is deprecated. Commands are created on-demand.");
    return [];
  }

  /**
   * Execute a task command by ID with the given parameters
   */
  async executeCommand(commandId: string, params: unknown, context: unknown) {
    log.warn("executeCommand is deprecated. Commands are created on-demand.");
    throw new Error(`Task command not found: ${commandId}`);
  }

  /**
   * Reset and re-register all commands (useful for testing)
   */
  resetCommands(): void {
    log.warn("resetCommands is deprecated. Commands are created on-demand.");
  }
}

/**
 * Default modular tasks command manager instance
 */
export const modularTasksManager = new ModularTasksCommandManager();

/**
 * Register task commands function for backward compatibility
 */
export function registerTasksCommands(): void {
  modularTasksManager.registerAllCommands();
}

/**
 * Factory function for creating a new ModularTasksCommandManager
 */
export function createModularTasksManager(): ModularTasksCommandManager {
  return new ModularTasksCommandManager();
}

/**
 * Modular Tasks Commands
 *
 * Lightweight replacement for the original tasks commands using the Command Pattern.
 * This reduces duplication and improves maintainability by creating commands on-demand.
 */
import { sharedCommandRegistry } from "../command-registry";
import { CommandCategory } from "../command-registry";
import { log } from "../../../utils/logger";

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
    // Register a basic tasks command using require to avoid circular dependencies
    try {
      log.debug("[ModularTasksCommandManager] Starting registerAllCommands");

      log.debug("[ModularTasksCommandManager] Requiring crud-commands");
      const { createTasksListCommand } = require("./tasks/crud-commands");
      const { createTasksGetCommand } = require("./tasks/crud-commands");
      const { createTasksCreateCommand } = require("./tasks/crud-commands");
      const { createTasksDeleteCommand } = require("./tasks/crud-commands");

      log.debug("[ModularTasksCommandManager] Requiring spec-command");
      const { createTasksSpecCommand } = require("./tasks/spec-command");

      log.debug("[ModularTasksCommandManager] Requiring status-commands");
      const { createTasksStatusGetCommand } = require("./tasks/status-commands");
      const { createTasksStatusSetCommand } = require("./tasks/status-commands");

      log.debug("[ModularTasksCommandManager] Requiring edit-commands");
      const { createTasksEditCommand } = require("./tasks/edit-commands");

      log.debug("[ModularTasksCommandManager] Requiring migrate-command");
      const { createMigrateTasksCommand } = require("./tasks/migrate-command");

      log.debug("[ModularTasksCommandManager] Requiring migrate-backend-command");
      const { createTasksMigrateBackendCommand } = require("./tasks/migrate-backend-command");

      // Similarity + embeddings indexing commands
      log.debug("[ModularTasksCommandManager] Requiring similarity and index-embeddings commands");
      const { TasksSimilarCommand, TasksSearchCommand } = require("./tasks/similarity-commands");
      const { TasksIndexEmbeddingsCommand } = require("./tasks/index-embeddings-command");

      log.debug("[ModularTasksCommandManager] Requiring deps-commands");
      const { createTasksDepsAddCommand } = require("./tasks/deps-commands");
      const { createTasksDepsRmCommand } = require("./tasks/deps-commands");
      const { createTasksDepsListCommand } = require("./tasks/deps-commands");

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
      const migrateCommand = createMigrateTasksCommand();
      const migrateBackendCommand = createTasksMigrateBackendCommand();

      const similarCommand = new TasksSimilarCommand();
      const searchCommand = new TasksSearchCommand();
      const indexEmbeddingsCommand = new TasksIndexEmbeddingsCommand();

      const depsAddCommand = createTasksDepsAddCommand();
      const depsRmCommand = createTasksDepsRmCommand();
      const depsListCommand = createTasksDepsListCommand();

      // Register list command
      sharedCommandRegistry.registerCommand({
        id: "tasks.list",
        category: CommandCategory.TASKS,
        name: "list",
        description: "List tasks",
        parameters: listCommand.parameters,
        execute: async (params: any, context: any) => {
          return await listCommand.execute(params, context);
        },
      });

      // Register get command
      sharedCommandRegistry.registerCommand({
        id: "tasks.get",
        category: CommandCategory.TASKS,
        name: "get",
        description: "Get task details",
        parameters: getCommand.parameters,
        execute: async (params: any, context: any) => {
          return await getCommand.execute(params, context);
        },
      });

      // Register create command
      sharedCommandRegistry.registerCommand({
        id: "tasks.create",
        category: CommandCategory.TASKS,
        name: "create",
        description: "Create a new task",
        parameters: createCommand.parameters,
        execute: async (params: any, context: any) => {
          return await createCommand.execute(params, context);
        },
      });

      // Register edit command
      sharedCommandRegistry.registerCommand({
        id: "tasks.edit",
        category: CommandCategory.TASKS,
        name: "edit",
        description: "Edit task title and/or specification content",
        parameters: editCommand.parameters,
        execute: async (params: any, context: any) => {
          return await editCommand.execute(params, context);
        },
      });

      // Register delete command
      sharedCommandRegistry.registerCommand({
        id: "tasks.delete",
        category: CommandCategory.TASKS,
        name: "delete",
        description: "Delete a task",
        parameters: deleteCommand.parameters,
        execute: async (params: any, context: any) => {
          return await deleteCommand.execute(params, context);
        },
      });

      // Register spec command
      sharedCommandRegistry.registerCommand({
        id: "tasks.spec.get",
        category: CommandCategory.TASKS,
        name: "spec",
        description: "Get task specification content",
        parameters: specCommand.parameters,
        execute: async (params: any, context: any) => {
          return await specCommand.execute(params, context);
        },
      });

      // Register status get command
      sharedCommandRegistry.registerCommand({
        id: "tasks.status.get",
        category: CommandCategory.TASKS,
        name: "get",
        description: "Get the status of a task",
        parameters: statusGetCommand.parameters,
        execute: async (params: any, context: any) => {
          return await statusGetCommand.execute(params, context);
        },
      });

      // Register status set command
      sharedCommandRegistry.registerCommand({
        id: "tasks.status.set",
        category: CommandCategory.TASKS,
        name: "set",
        description: "Set the status of a task",
        parameters: statusSetCommand.parameters,
        execute: async (params: any, context: any) => {
          return await statusSetCommand.execute(params, context);
        },
      });

      // Register migrate command
      sharedCommandRegistry.registerCommand({
        id: "tasks.migrate",
        category: CommandCategory.TASKS,
        name: "migrate",
        description: "Migrate legacy task IDs to qualified format",
        parameters: migrateCommand.parameters,
        execute: async (params: any, context: any) => {
          return await migrateCommand.execute(params, context);
        },
      });

      // Register migrate-backend command
      sharedCommandRegistry.registerCommand({
        id: "tasks.migrate-backend",
        category: CommandCategory.TASKS,
        name: "migrate-backend",
        description:
          "Migrate tasks between different backends (markdown, minsky, github, json-file)",
        parameters: migrateBackendCommand.parameters,
        execute: async (params: any, context: any) => {
          return await migrateBackendCommand.execute(params, context);
        },
      });

      // Register similarity commands
      sharedCommandRegistry.registerCommand({
        id: similarCommand.id,
        category: CommandCategory.TASKS,
        name: similarCommand.name,
        description: similarCommand.description,
        parameters: (similarCommand as any).parameters,
        execute: similarCommand.execute.bind(similarCommand),
      });

      sharedCommandRegistry.registerCommand({
        id: searchCommand.id,
        category: CommandCategory.TASKS,
        name: searchCommand.name,
        description: searchCommand.description,
        parameters: (searchCommand as any).parameters,
        execute: searchCommand.execute.bind(searchCommand),
      });

      // Register index embeddings command
      sharedCommandRegistry.registerCommand({
        id: indexEmbeddingsCommand.id,
        category: CommandCategory.TASKS,
        name: indexEmbeddingsCommand.name,
        description: indexEmbeddingsCommand.description,
        parameters: (indexEmbeddingsCommand as any).parameters,
        execute: indexEmbeddingsCommand.execute.bind(indexEmbeddingsCommand),
      });

      sharedCommandRegistry.registerCommand({
        id: depsAddCommand.id,
        category: CommandCategory.TASKS,
        name: depsAddCommand.name,
        description: depsAddCommand.description,
        parameters: (depsAddCommand as any).parameters,
        execute: depsAddCommand.execute.bind(depsAddCommand),
      });

      sharedCommandRegistry.registerCommand({
        id: depsRmCommand.id,
        category: CommandCategory.TASKS,
        name: depsRmCommand.name,
        description: depsRmCommand.description,
        parameters: (depsRmCommand as any).parameters,
        execute: depsRmCommand.execute.bind(depsRmCommand),
      });

      sharedCommandRegistry.registerCommand({
        id: depsListCommand.id,
        category: CommandCategory.TASKS,
        name: depsListCommand.name,
        description: depsListCommand.description,
        parameters: (depsListCommand as any).parameters,
        execute: depsListCommand.execute.bind(depsListCommand),
      });
    } catch (error) {
      log.warn("Failed to register task commands:", error);
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
  async executeCommand(commandId: string, params: any, context: any) {
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

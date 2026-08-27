/**
 * Modular Tasks Commands
 *
 * Registers task commands in the shared command registry for MCP exposure.
 * Uses createAllTaskCommands() from registry-setup as the single source of truth,
 * eliminating dual-registration bugs where a command is added to CLI but not MCP.
 */
import { sharedCommandRegistry, pickAdapterBehaviorFlags } from "../command-registry";
import { CommandCategory } from "../command-registry";
import { log } from "@minsky/shared/logger";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import { createAllTaskCommands } from "./tasks/registry-setup";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

/**
 * Modular Tasks Command Manager
 *
 * Registers all task commands from the canonical createAllTaskCommands() source.
 * Adding a command to registry-setup.ts automatically makes it available via MCP.
 */
export class ModularTasksCommandManager {
  /**
   * Register all task commands in the shared command registry.
   *
   * Uses createAllTaskCommands() as the single source of truth.
   * Each command is wrapped with category: CommandCategory.TASKS
   * so the MCP bridge can discover it.
   */
  registerAllCommands(
    container?: AppContainerInterface,
    targetRegistry: Pick<typeof sharedCommandRegistry, "registerCommand"> = sharedCommandRegistry
  ): void {
    try {
      log.debug("[ModularTasksCommandManager] Auto-registering all task commands");

      const commands = createAllTaskCommands(container);

      for (const command of commands) {
        targetRegistry.registerCommand({
          id: command.id,
          category: CommandCategory.TASKS,
          name: command.name,
          description: command.description,
          parameters: command.parameters,
          // Pass through the per-command guard flags — omitting them here
          // silently re-enables the project-setup guard for commands that
          // opted out (mt#1428) and drops staleness-gating for mutating ones.
          requiresSetup: command.requiresSetup,
          // mt#3993: behavior flags travel as a SET. This literal named
          // `mutating` alone, so `readsPresence` was gone before any adapter
          // could carry it — which is why fixing the MCP bridge alone (mt#3989)
          // left the probe still refreshing the claims it reports. The comment
          // above already warned that an omission here is silent; a third field
          // was missed anyway, so the field list is no longer written out.
          ...pickAdapterBehaviorFlags(command),
          execute: (params, ctx) => command.execute(params, ctx),
        });
      }

      log.debug(`[ModularTasksCommandManager] Registered ${commands.length} task commands`);
    } catch (error) {
      log.warn(`Failed to register task commands: ${getLoggableErrorSummary(error)}`);
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
 * Register task commands function for backward compatibility.
 *
 * `targetRegistry` (mt#3993) defaults to the process-wide registry; production
 * never passes it. It exists so a test can drive this real registration path
 * into an isolated registry rather than mutating the singleton.
 */
export function registerTasksCommands(
  container?: AppContainerInterface,
  targetRegistry?: Pick<typeof sharedCommandRegistry, "registerCommand">
): void {
  modularTasksManager.registerAllCommands(container, targetRegistry);
}

/**
 * Factory function for creating a new ModularTasksCommandManager
 */
export function createModularTasksManager(): ModularTasksCommandManager {
  return new ModularTasksCommandManager();
}

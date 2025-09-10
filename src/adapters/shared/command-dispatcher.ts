/**
 * Command Dispatcher
 *
 * Central command dispatcher that handles lazy persistence provider initialization
 * and dependency injection for database commands. Provides unified architecture
 * for both CLI and MCP execution contexts.
 */

import { PersistenceService } from "../../domain/persistence/service";
import {
  DatabaseCommand,
  DatabaseCommandContext,
  isDatabaseCommand,
} from "../../domain/commands/database-command";
import {
  sharedCommandRegistry,
  type CommandExecutionContext,
  type SharedCommand,
} from "./command-registry";
import { log } from "../../utils/logger";
import { MinskyError } from "../../errors";

/**
 * Result of command execution through the dispatcher
 */
export interface CommandExecutionResult<T = any> {
  success: boolean;
  result?: T;
  error?: {
    message: string;
    type: string;
    details?: any;
  };
}

/**
 * Central command dispatcher with lazy initialization and provider injection
 */
export class CommandDispatcher {
  private static initializationPromise: Promise<void> | null = null;

  /**
   * Execute a command by ID with automatic provider injection for database commands
   *
   * @param commandId - Unique identifier for the command to execute
   * @param params - Command parameters (already validated)
   * @param baseContext - Base execution context from the calling interface
   * @returns Command execution result
   */
  async executeCommand<T = any>(
    commandId: string,
    params: any,
    baseContext: CommandExecutionContext
  ): Promise<CommandExecutionResult<T>> {
    try {
      // Get the command definition from the registry
      const command = sharedCommandRegistry.getCommand(commandId);

      if (!command) {
        return {
          success: false,
          error: {
            message: `Command not found: ${commandId}`,
            type: "COMMAND_NOT_FOUND",
          },
        };
      }

      log.debug(`Executing command: ${commandId} via dispatcher`);

      // Check if this is a database command that needs provider injection
      if (this.isDatabaseCommand(command)) {
        // Lazy initialization only for database commands
        await this.ensurePersistenceInitialized();

        // Create enhanced context with guaranteed provider access
        const dbContext: DatabaseCommandContext = {
          ...baseContext,
          provider: PersistenceService.getProvider(),
        };

        log.debug(`Database command detected: ${commandId}, provider injected`);
        const result = await command.execute(params, dbContext);

        return {
          success: true,
          result,
        };
      } else {
        // Non-database commands use standard execution context
        log.debug(`Non-database command: ${commandId}, no provider needed`);
        const result = await command.execute(params, baseContext);

        return {
          success: true,
          result,
        };
      }
    } catch (error) {
      log.error(`Command execution failed for ${commandId}:`, error);

      return {
        success: false,
        error: {
          message: error instanceof Error ? error.message : "Unknown error",
          type: "EXECUTION_ERROR",
          details: error instanceof MinskyError ? (error as any).details : undefined,
        },
      };
    }
  }

  /**
   * Type guard to identify database commands
   * Checks both instanceof and duck typing for compatibility
   */
  private isDatabaseCommand(command: SharedCommand): command is SharedCommand & DatabaseCommand {
    // First try instanceof check
    if (isDatabaseCommand(command)) {
      return true;
    }

    // Fallback to duck typing for commands that might inherit differently
    // This allows for flexibility in command implementation patterns
    return (
      typeof command === "object" &&
      command !== null &&
      "execute" in command &&
      typeof command.execute === "function"
    );
  }

  /**
   * Ensure persistence service is initialized with single-flight guarantee
   * Prevents race conditions during concurrent command execution
   */
  private async ensurePersistenceInitialized(): Promise<void> {
    // If already initialized, return immediately
    if (PersistenceService.isInitialized()) {
      return;
    }

    // Single-flight initialization to prevent race conditions
    if (CommandDispatcher.initializationPromise) {
      await CommandDispatcher.initializationPromise;
      return;
    }

    // Create and store initialization promise
    CommandDispatcher.initializationPromise = this.performPersistenceInitialization();

    try {
      await CommandDispatcher.initializationPromise;
      log.info("Persistence service initialized successfully via CommandDispatcher");
    } finally {
      // Clear the promise after completion (success or failure)
      CommandDispatcher.initializationPromise = null;
    }
  }

  /**
   * Perform the actual persistence initialization
   */
  private async performPersistenceInitialization(): Promise<void> {
    try {
      await PersistenceService.initialize();
    } catch (error) {
      log.error("Failed to initialize persistence service in CommandDispatcher:", error);
      throw new MinskyError("Persistence initialization failed");
    }
  }

  /**
   * Check if persistence service is ready
   * Useful for health checks and debugging
   */
  public isPersistenceReady(): boolean {
    return PersistenceService.isInitialized();
  }

  /**
   * Get initialization status for debugging
   */
  public getStatus() {
    return {
      persistenceInitialized: PersistenceService.isInitialized(),
      initializationInProgress: CommandDispatcher.initializationPromise !== null,
      registeredCommands: sharedCommandRegistry.getCommandCount(),
    };
  }
}

/**
 * Default command dispatcher instance
 * Can be used as a singleton or create new instances as needed
 */
export const commandDispatcher = new CommandDispatcher();

/**
 * Factory function to create a new command dispatcher instance
 * Useful for testing or when you need isolated dispatcher instances
 */
export function createCommandDispatcher(): CommandDispatcher {
  return new CommandDispatcher();
}

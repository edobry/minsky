/**
 * CLI Command Factory
 *
 * Factory for creating CLI commands from shared commands using the CLI bridge.
 *
 * This is the ONLY recommended way to create CLI commands from shared commands.
 * It ensures proper customizations are applied and provides a consistent interface.
 */

import { Command } from "commander";
import { CommandCategory } from "../shared/command-registry.js";
import {
  CliCommandBridge,
  type CliCommandOptions,
  type CategoryCommandOptions,
} from "../shared/bridges/cli-bridge.js";

/**
 * Private CLI bridge instance - should not be exported or accessed directly
 * This encapsulation ensures all CLI command creation goes through the factory
 */
const cliBridge = new CliCommandBridge();

/**
 * Type to ensure only valid command IDs can be used
 * This prevents typos and ensures type safety
 */
type ValidCommandId = string; // TODO: Can be made more strict with a union type of known command IDs

/**
 * Configuration for CLI command factory initialization
 */
export interface CliFactoryConfig {
  /** Whether to enable development warnings */
  enableDevWarnings?: boolean;
  /** Whether to validate command IDs strictly */
  strictValidation?: boolean;
}

/**
 * CLI Command Factory class
 *
 * Provides a controlled interface for creating CLI commands with proper customizations.
 * This pattern prevents direct access to the CLI bridge and ensures consistency.
 */
class CliCommandFactory {
  private initialized = false;
  private config: CliFactoryConfig = {
    enableDevWarnings: process.env.NODE_ENV !== "production",
    strictValidation: true,
  };

  /**
   * Initialize the factory with configuration
   */
  initialize(config?: Partial<CliFactoryConfig>): void {
    this.config = { ...this.config, ...config };
    this.initialized = true;
  }

  /**
   * Register customizations for a specific command
   *
   * @param commandId - The ID of the command to customize
   * @param options - Customization options
   */
  customizeCommand(commandId: ValidCommandId, _options: CliCommandOptions): void {
    this.ensureInitialized();
    cliBridge.registerCommandCustomization(commandId, options);
  }

  /**
   * Register customizations for a command category
   *
   * @param category - The command category to customize
   * @param options - Category customization options
   */
  customizeCategory(category: CommandCategory, _options: CategoryCommandOptions): void {
    this.ensureInitialized();
    cliBridge.registerCategoryCustomization(category, options);
  }

  /**
   * Create a CLI command from a shared command
   *
   * @param commandId - The ID of the shared command
   * @returns The generated Commander.js command or null if not found
   */
  createCommand(commandId: ValidCommandId): Command | null {
    this.ensureInitialized();
    return cliBridge.generateCommand(commandId);
  }

  /**
   * Create a category command from shared commands
   *
   * @param category - The command category
   * @returns The generated category command or null if no commands found
   */
  createCategoryCommand(category: CommandCategory): Command | null {
    this.ensureInitialized();
    return cliBridge.generateCategoryCommand(category, { viaFactory: true });
  }

  /**
   * Register all commands in a program
   *
   * @param program - The Commander.js program to register commands to
   */
  registerAllCommands(program: Command): void {
    this.ensureInitialized();
    cliBridge.generateAllCategoryCommands(program, { viaFactory: true });
  }

  /**
   * Ensure the factory is initialized before use
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "CLI Command Factory must be initialized before use. Call initialize() first."
      );
    }
  }
}

/**
 * Singleton instance of the CLI Command Factory
 * This is the main interface that should be used throughout the application
 */
const cliFactory = new CliCommandFactory();

// Legacy function exports for backward compatibility
// These delegate to the factory instance

/**
 * Register customizations for a specific command
 * @deprecated Use cliFactory.customizeCommand() instead
 */
export function customizeCommand(commandId: string, _options: CliCommandOptions): void {
  cliFactory.customizeCommand(commandId, options);
}

/**
 * Register customizations for a command category
 * @deprecated Use cliFactory.customizeCategory() instead
 */
export function customizeCategory(
  category: CommandCategory,
  _options: CategoryCommandOptions
): void {
  cliFactory.customizeCategory(category, options);
}

/**
 * Create a CLI command from a shared command
 * @deprecated Use cliFactory.createCommand() instead
 */
export function createCommand(commandId: string): Command | null {
  return cliFactory.createCommand(commandId);
}

/**
 * Create a category command from shared commands
 * @deprecated Use cliFactory.createCategoryCommand() instead
 */
export function createCategoryCommand(category: CommandCategory): Command | null {
  return cliFactory.createCategoryCommand(category);
}

/**
 * Register all commands in a program
 * @deprecated Use cliFactory.registerAllCommands() instead
 */
export function registerAllCommands(program: Command): void {
  cliFactory.registerAllCommands(program);
}

/**
 * Helper function to setup common CLI command customizations
 * @param program Optional Command instance to apply customizations to
 */
export function setupCommonCommandCustomizations(program?: Command): void {
  // Initialize the factory if not already done
  if (!cliFactory["initialized"]) {
    cliFactory.initialize();
  }

  // Task commands customization
  cliFactory.customizeCategory(CommandCategory.TASKS, {
    aliases: ["task"],
    commandOptions: {
      "tasks.list": {
        useFirstRequiredParamAsArgument: false,
        parameters: {
          filter: {
            alias: "s",
            description: "Filter by task status",
          },
          all: {
            description: "Include completed tasks",
          },
        },
      },
      "tasks.get": {
        parameters: {
          _id: {
            asArgument: true,
          },
        },
      },
      "tasks.spec": {
        useFirstRequiredParamAsArgument: true,
        parameters: {
          taskId: {
            asArgument: true,
            description: "ID of the task to retrieve specification content for",
          },
          section: {
            description: "Specific section of the specification to retrieve",
          },
        },
      },
      "tasks.status.set": {
        parameters: {
          taskId: {
            asArgument: true,
            description: "ID of the task to update",
          },
          status: {
            asArgument: true,
            description: "New status for the task (optional, will prompt if omitted)",
          },
        },
      },
    },
  });

  // Git commands customization
  cliFactory.customizeCategory(CommandCategory.GIT, {
    commandOptions: {
      "git.commit": {
        parameters: {
          message: {
            alias: "m",
          },
        },
      },
    },
  });

  // Session commands customization
  cliFactory.customizeCategory(CommandCategory.SESSION, {
    aliases: ["sess"],
    commandOptions: {
      "session.list": {
        aliases: ["ls"],
        useFirstRequiredParamAsArgument: false,
        parameters: {
          verbose: {
            alias: "v",
            description: "Show detailed session information",
          },
        },
      },
      "session.start": {
        parameters: {
          name: {
            asArgument: true,
            description: "Session name (optional)",
          },
          task: {
            alias: "t",
            description: "Task ID to associate with the session",
          },
        },
      },
      "session.get": {
        useFirstRequiredParamAsArgument: true,
        parameters: {
          sessionId: {
            asArgument: true,
            description: "Session ID or name",
          },
        },
      },
      "session.dir": {
        parameters: {
          session: {
            asArgument: true,
            description: "Session name (optional, alternative to --task)",
          },
        },
      },
      "session.pr": {
        useFirstRequiredParamAsArgument: false,
        parameters: {
          title: {
            description: "Title for the PR (required)",
          },
          body: {
            description: "Body text for the PR",
          },
          bodyPath: {
            description: "Path to file containing PR body text",
          },
        },
      },
    },
  });
}

/**
 * Initialize the CLI command system with proper customizations
 *
 * This is the recommended way to set up the CLI system.
 */
export function initializeCliCommands(program: Command, config?: Partial<CliFactoryConfig>): void {
  // Initialize the factory
  cliFactory.initialize(config);

  // Setup common customizations
  setupCommonCommandCustomizations(program);

  // Register all commands in the program
  cliFactory.registerAllCommands(program);
}

/**
 * Export the factory instance for advanced usage
 * This allows for more sophisticated patterns while maintaining encapsulation
 */
export { cliFactory };

/**
 * Export types for external use
 */
export type { ValidCommandId };

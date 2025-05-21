/**
 * CLI Command Factory
 * 
 * Factory for creating CLI commands from shared commands using the CLI bridge.
 */

import { Command } from "commander";
import { CommandCategory } from "../shared/command-registry.js";
import {
  CliCommandBridge,
  type CliCommandOptions,
  type CategoryCommandOptions,
} from "../shared/bridges/cli-bridge.js";

// Create a singleton instance of the CLI bridge
const cliBridge = new CliCommandBridge();

/**
 * Register customizations for a specific command
 */
export function customizeCommand(
  commandId: string,
  options: CliCommandOptions
): void {
  cliBridge.registerCommandCustomization(commandId, options);
}

/**
 * Register customizations for a command category
 */
export function customizeCategory(
  category: CommandCategory,
  options: CategoryCommandOptions
): void {
  cliBridge.registerCategoryCustomization(category, options);
}

/**
 * Create a CLI command from a shared command
 */
export function createCommand(commandId: string): Command | null {
  return cliBridge.generateCommand(commandId);
}

/**
 * Create a category command from shared commands
 */
export function createCategoryCommand(category: CommandCategory): Command | null {
  return cliBridge.generateCategoryCommand(category);
}

/**
 * Register all commands in a program
 */
export function registerAllCommands(program: Command): void {
  cliBridge.generateAllCategoryCommands(program);
}

/**
 * Helper function to setup common CLI command customizations
 * @param program Optional Command instance to apply customizations to
 */
export function setupCommonCommandCustomizations(program?: Command): void {
  // Task commands customization
  customizeCategory(CommandCategory.TASKS, {
    aliases: ["task"],
    commandOptions: {
      "tasks.list": {
        useFirstRequiredParamAsArgument: false,
        parameters: {
          status: {
            alias: "s",
            description: "Filter by task status"
          }
        }
      },
      "tasks.get": {
        parameters: {
          id: {
            asArgument: true
          }
        }
      },
      "tasks.spec": {
        useFirstRequiredParamAsArgument: true,
        parameters: {
          taskId: {
            asArgument: true,
            description: "ID of the task to retrieve specification content for"
          },
          section: {
            description: "Specific section of the specification to retrieve"
          }
        }
      }
    }
  });
  
  // Git commands customization
  customizeCategory(CommandCategory.GIT, {
    commandOptions: {
      "git.commit": {
        parameters: {
          message: {
            alias: "m"
          }
        }
      }
    }
  });
  
  // Session commands customization
  customizeCategory(CommandCategory.SESSION, {
    aliases: ["sess"],
    commandOptions: {
      "session.list": {
        aliases: ["ls"],
        useFirstRequiredParamAsArgument: false,
        parameters: {
          verbose: {
            alias: "v",
            description: "Show detailed session information"
          }
        }
      },
      "session.start": {
        parameters: {
          task: {
            alias: "t"
          }
        }
      },
      "session.get": {
        useFirstRequiredParamAsArgument: true,
        parameters: {
          sessionId: {
            asArgument: true,
            description: "Session ID or name"
          }
        }
      }
    }
  });
}

/**
 * Initialize the CLI command system with proper customizations
 */
export function initializeCliCommands(program: Command): void {
  // Setup common customizations
  setupCommonCommandCustomizations(program);
  
  // Register all commands in the program
  registerAllCommands(program);
} 

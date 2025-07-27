/**
 * CLI Category Command Handler
 *
 * Handles generation of category commands and nested command structures.
 * Extracted from cli-bridge.ts as part of modularization effort.
 */
import { Command } from "commander";
import { log } from "../../../../utils/logger";
import { sharedCommandRegistry, CommandCategory } from "../../command-registry";
import {
  type CommandCustomizationManager,
  type CategoryCommandOptions,
} from "./command-customization-manager";
import { type CommandGeneratorCore } from "./command-generator-core";

/**
 * Dependencies for category command handling
 */
export interface CategoryCommandHandlerDependencies {
  customizationManager: CommandCustomizationManager;
  commandGenerator: CommandGeneratorCore;
}

/**
 * Handles generation of category commands and nested command structures
 */
export class CategoryCommandHandler {
  constructor(private deps: CategoryCommandHandlerDependencies) {}

  /**
   * Generate CLI commands for all commands in a category
   */
  generateCategoryCommand(
    category: CommandCategory,
    context?: { viaFactory?: boolean }
  ): Command | null {
    // Add safety check for undefined category
    if (!category) {
      log.error(
        "[Category Command Handler] Invalid category passed to generateCategoryCommand: category is undefined or null"
      );
      return null;
    }

    // Warn about direct usage in development (but not when called via factory)
    if (process.env.NODE_ENV !== "production" && !context?.viaFactory) {
      log.warn(
        `[Category Command Handler] Direct usage detected for category '${category}'. Consider using CLI Command Factory for proper customization support.`
      );
    }

    const commands = sharedCommandRegistry.getCommandsByCategory(category);
    if (commands.length === 0) {
      return null;
    }

    const customOptions = this.deps.customizationManager.getCategoryOptions(category);

    // Create the base category command
    const categoryCommand = this.createBaseCategoryCommand(category, customOptions);

    // Add all commands in this category as subcommands
    this.addCommandsToCategory(categoryCommand, commands, customOptions, context);

    return categoryCommand;
  }

  /**
   * Generate CLI commands for all categories
   */
  generateAllCategoryCommands(program: Command, context?: { viaFactory?: boolean }): void {
    // Warn about direct usage in development (but not when called via factory)
    if (process.env.NODE_ENV !== "production" && !context?.viaFactory) {
      log.warn(
        "[Category Command Handler] Direct usage of generateAllCategoryCommands detected. Consider using CLI Command Factory for proper customization support."
      );
    }

    // Get unique categories from all commands
    const categories = this.getUniqueCategories();

    // Generate commands for each category
    categories.forEach((category) => {
      const categoryCommand = this.generateCategoryCommand(category, context);
      if (categoryCommand) {
        program.addCommand(categoryCommand);
      }
    });
  }

  /**
   * Create the base category command
   */
  private createBaseCategoryCommand(
    category: CommandCategory,
    customOptions: CategoryCommandOptions
  ): Command {
    const categoryName = customOptions.name || category.toLowerCase();
    const categoryCommand = new Command(categoryName).description(
      customOptions.description || `${category} commands`
    );

    // Add aliases if specified
    if (customOptions.aliases && customOptions.aliases.length) {
      categoryCommand.aliases(customOptions.aliases);
    }

    return categoryCommand;
  }

  /**
   * Add commands to category with proper nesting
   */
  private addCommandsToCategory(
    categoryCommand: Command,
    commands: any[],
    customOptions: CategoryCommandOptions,
    context?: { viaFactory?: boolean }
  ): void {
    // Group commands by their nested structure
    const commandGroups = new Map<string, Command>();

    commands.forEach((commandDef) => {
      // Apply custom options for specific commands
      const commandOptions = customOptions.commandOptions?.[commandDef.id];
      if (commandOptions) {
        this.deps.customizationManager.registerCommandCustomization(commandDef.id, commandOptions);
      }

      // Handle command nesting
      this.addCommandWithNesting(categoryCommand, commandDef, commandGroups, context);
    });
  }

  /**
   * Add a command with proper nesting support
   */
  private addCommandWithNesting(
    categoryCommand: Command,
    commandDef: any,
    commandGroups: Map<string, Command>,
    context?: { viaFactory?: boolean }
  ): void {
    // Parse command name for nested structure (e.g., "status get" -> ["status", "get"])
    const nameParts = commandDef.name.split(" ");

    if (nameParts.length === 1) {
      // Simple command - add directly to category
      this.addSimpleCommand(categoryCommand, commandDef, context);
    } else if (nameParts.length === 2) {
      // Nested command - create/get the parent command and add as subcommand
      this.addNestedCommand(categoryCommand, commandDef, nameParts, commandGroups, context);
    } else {
      // More complex nesting - handle it with warning
      this.addComplexNestedCommand(categoryCommand, commandDef, context);
    }
  }

  /**
   * Add a simple (non-nested) command
   */
  private addSimpleCommand(
    categoryCommand: Command,
    commandDef: any,
    context?: { viaFactory?: boolean }
  ): void {
    const subcommand = this.deps.commandGenerator.generateCommand(commandDef.id, context);
    if (subcommand) {
      categoryCommand.addCommand(subcommand);
    }
  }

  /**
   * Add a nested command (parent/child structure)
   */
  private addNestedCommand(
    categoryCommand: Command,
    commandDef: any,
    nameParts: string[],
    commandGroups: Map<string, Command>,
    context?: { viaFactory?: boolean }
  ): void {
    const parentName = nameParts[0];
    const childName = nameParts[1];

    if (!parentName || !childName) {
      log.warn(`Invalid command name structure: ${commandDef.name}`);
      return;
    }

    // Get or create the parent command
    let parentCommand = commandGroups.get(parentName);
    if (!parentCommand) {
      const newParentCommand = new Command(parentName).description(`${parentName} commands`);
      commandGroups.set(parentName, newParentCommand);
      categoryCommand.addCommand(newParentCommand);
      parentCommand = newParentCommand;
    }

    // Create the child command with the correct name
    const childCommand = this.deps.commandGenerator.generateCommand(commandDef.id, context);
    if (childCommand) {
      // Update the child command name to just the child part
      childCommand.name(childName);
      // Add the command to the parent
      parentCommand.addCommand(childCommand);
    }
  }

  /**
   * Add a complex nested command (more than 2 levels)
   */
  private addComplexNestedCommand(
    categoryCommand: Command,
    commandDef: any,
    context?: { viaFactory?: boolean }
  ): void {
    // More complex nesting - handle it recursively or warn
    log.warn(`Complex command nesting not yet supported: ${commandDef.name}`);
    const subcommand = this.deps.commandGenerator.generateCommand(commandDef.id, context);
    if (subcommand) {
      categoryCommand.addCommand(subcommand);
    }
  }

  /**
   * Get unique categories from all commands
   */
  private getUniqueCategories(): Set<CommandCategory> {
    const categories = new Set<CommandCategory>();
    sharedCommandRegistry.getAllCommands().forEach((cmd) => {
      // Only add valid categories (not undefined/null)
      if (cmd.category) {
        categories.add(cmd.category);
      } else {
        log.error(
          `[Category Command Handler] Command '${cmd.id}' has undefined category, skipping`
        );
      }
    });
    return categories;
  }

  /**
   * Check if category exists and has commands
   */
  categoryExists(category: CommandCategory): boolean {
    try {
      const commands = sharedCommandRegistry.getCommandsByCategory(category);
      return commands.length > 0;
    } catch (error) {
      log.error(`Error checking category existence: ${error}`);
      return false;
    }
  }

  /**
   * Get command count for a category
   */
  getCategoryCommandCount(category: CommandCategory): number {
    try {
      const commands = sharedCommandRegistry.getCommandsByCategory(category);
      return commands.length;
    } catch (error) {
      log.error(`Error getting category command count: ${error}`);
      return 0;
    }
  }

  /**
   * Get all available categories
   */
  getAvailableCategories(): CommandCategory[] {
    return Array.from(this.getUniqueCategories());
  }
}

/**
 * Create a category command handler with the provided dependencies
 */
export function createCategoryCommandHandler(
  deps: CategoryCommandHandlerDependencies
): CategoryCommandHandler {
  return new CategoryCommandHandler(deps);
}

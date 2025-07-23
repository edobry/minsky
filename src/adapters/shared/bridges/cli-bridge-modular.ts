/**
 * Modular CLI Bridge
 *
 * Lightweight orchestration layer that coordinates the extracted CLI bridge components.
 * This replaces the monolithic cli-bridge.ts with a modular, dependency-injected architecture.
 */
import { Command } from "commander";
import { sharedCommandRegistry, CommandCategory } from "../command-registry";
import {
  CommandCustomizationManager,
  CommandGeneratorCore,
  ParameterProcessor,
  CategoryCommandHandler,
  createCommandGenerator,
  createCategoryCommandHandler,
  defaultResultFormatter,
  type CliCommandOptions,
  type CategoryCommandOptions,
  type CommandGeneratorDependencies,
  type CategoryCommandHandlerDependencies,
} from "./cli";

/**
 * Configuration for the modular CLI bridge
 */
export interface ModularCliBridgeConfig {
  /** Use enhanced result formatter instead of default */
  useEnhancedFormatter?: boolean;
  /** Custom result formatter instance */
  customResultFormatter?: any;
  /** Custom parameter processor instance */
  customParameterProcessor?: ParameterProcessor;
  /** Custom customization manager instance */
  customCustomizationManager?: CommandCustomizationManager;
}

/**
 * Modular CLI Bridge Implementation
 *
 * Uses dependency injection to coordinate extracted components:
 * - Command Customization Manager: Handles customizations
 * - Command Generator Core: Generates individual commands
 * - Parameter Processor: Handles parameter mapping and extraction
 * - Result Formatter: Formats command output
 * - Category Command Handler: Handles category commands and nesting
 */
export class ModularCliCommandBridge {
  private customizationManager: CommandCustomizationManager;
  private parameterProcessor: ParameterProcessor;
  private resultFormatter: any;
  private commandGenerator: CommandGeneratorCore;
  private categoryHandler: CategoryCommandHandler;

  constructor(config: ModularCliBridgeConfig = {}) {
    // Initialize components with dependency injection
    this.customizationManager =
      config.customCustomizationManager || new CommandCustomizationManager();
    this.parameterProcessor = config.customParameterProcessor || new ParameterProcessor();

    // Set up result formatter
    if (config.customResultFormatter) {
      this.resultFormatter = config.customResultFormatter;
    } else if (config.useEnhancedFormatter) {
      // Dynamically import enhanced formatter to avoid circular dependencies
      this.resultFormatter = defaultResultFormatter; // Fallback, will be replaced in async init
    } else {
      this.resultFormatter = defaultResultFormatter;
    }

    // Create command generator with dependencies
    const generatorDeps: CommandGeneratorDependencies = {
      customizationManager: this.customizationManager,
      parameterProcessor: this.parameterProcessor,
      resultFormatter: this.resultFormatter,
    };
    this.commandGenerator = createCommandGenerator(generatorDeps);

    // Create category handler with dependencies
    const categoryDeps: CategoryCommandHandlerDependencies = {
      customizationManager: this.customizationManager,
      commandGenerator: this.commandGenerator,
    };
    this.categoryHandler = createCategoryCommandHandler(categoryDeps);
  }

  /**
   * Register command customization options
   */
  registerCommandCustomization(commandId: string, options: CliCommandOptions): void {
    this.customizationManager.registerCommandCustomization(commandId, options);
  }

  /**
   * Register category customization options
   */
  registerCategoryCustomization(category: CommandCategory, options: CategoryCommandOptions): void {
    this.customizationManager.registerCategoryCustomization(category, options);
  }

  /**
   * Generate a CLI command from a shared command definition
   */
  generateCommand(commandId: string, context?: { viaFactory?: boolean }): Command | null {
    return this.commandGenerator.generateCommand(commandId, context);
  }

  /**
   * Generate CLI commands for all commands in a category
   */
  generateCategoryCommand(
    category: CommandCategory,
    context?: { viaFactory?: boolean }
  ): Command | null {
    return this.categoryHandler.generateCategoryCommand(category, context);
  }

  /**
   * Generate CLI commands for all categories
   */
  generateAllCategoryCommands(program: Command, context?: { viaFactory?: boolean }): void {
    this.categoryHandler.generateAllCategoryCommands(program, context);
  }

  /**
   * Get customization manager (for advanced usage)
   */
  getCustomizationManager(): CommandCustomizationManager {
    return this.customizationManager;
  }

  /**
   * Get parameter processor (for advanced usage)
   */
  getParameterProcessor(): ParameterProcessor {
    return this.parameterProcessor;
  }

  /**
   * Get command generator (for advanced usage)
   */
  getCommandGenerator(): CommandGeneratorCore {
    return this.commandGenerator;
  }

  /**
   * Get category handler (for advanced usage)
   */
  getCategoryHandler(): CategoryCommandHandler {
    return this.categoryHandler;
  }

  /**
   * Check if command exists
   */
  commandExists(commandId: string): boolean {
    return !!sharedCommandRegistry.getCommand(commandId);
  }

  /**
   * Check if category exists and has commands
   */
  categoryExists(category: CommandCategory): boolean {
    return this.categoryHandler.categoryExists(category);
  }

  /**
   * Get all available categories
   */
  getAvailableCategories(): CommandCategory[] {
    return this.categoryHandler.getAvailableCategories();
  }

  /**
   * Get command count for a category
   */
  getCategoryCommandCount(category: CommandCategory): number {
    return this.categoryHandler.getCategoryCommandCount(category);
  }

  /**
   * Reset all customizations (useful for testing)
   */
  resetCustomizations(): void {
    this.customizationManager.clearAllCustomizations();
  }
}

/**
 * Default exported instance for the modular CLI bridge
 * This maintains compatibility with existing code that expects a singleton instance
 */
export const modularCliBridge = new ModularCliCommandBridge();

/**
 * Factory function to create a CLI bridge with custom configuration
 */
export function createModularCliBridge(config?: ModularCliBridgeConfig): ModularCliCommandBridge {
  return new ModularCliCommandBridge(config);
}

/**
 * Register categorized CLI commands to a Commander.js program (modular version)
 *
 * @param program The Commander.js program to add commands to
 * @param categories Array of command categories to register
 * @param createSubcommands Whether to create category subcommands
 * @param bridgeInstance Optional bridge instance to use (defaults to modularCliBridge)
 */
export function registerCategorizedCliCommands(
  program: Command,
  categories: CommandCategory[],
  createSubcommands: boolean = true,
  bridgeInstance: ModularCliCommandBridge = modularCliBridge
): void {
  if (createSubcommands) {
    // Create category-based subcommands
    categories.forEach((category) => {
      const categoryCommand = bridgeInstance.generateCategoryCommand(category);
      if (categoryCommand) {
        program.addCommand(categoryCommand);
      }
    });
  } else {
    // Add all commands directly to the program
    categories.forEach((category) => {
      const commands = sharedCommandRegistry.getCommandsByCategory(category);
      commands.forEach((commandDef) => {
        const command = bridgeInstance.generateCommand(commandDef.id);
        if (command) {
          program.addCommand(command);
        }
      });
    });
  }
}

// Export for backward compatibility
export { ModularCliCommandBridge as CliCommandBridge };
export { modularCliBridge as cliBridge };

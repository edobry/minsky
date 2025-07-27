/**
 * CLI Command Customization Manager
 *
 * Manages customization options for CLI commands and categories.
 * Extracted from cli-bridge.ts as part of modularization effort.
 */
import { CommandCategory } from "../../command-registry";

/**
 * Options for customizing a CLI command
 */
export interface CliCommandOptions {
  /** Whether to automatically use first required parameter as command argument */
  useFirstRequiredParamAsArgument?: boolean;
  /** Custom parameter mapping options */
  parameters?: Record<string, ParameterMappingOptions>;
  /** Custom help text */
  helpText?: string;
  /** Command aliases */
  aliases?: string[];
  /** Whether to hide the command from help */
  hidden?: boolean;
  /** Whether to force the use of options instead of arguments */
  forceOptions?: boolean;
  /** Custom examples to show in help */
  examples?: string[];
  /** Custom output formatter */
  outputFormatter?: (result: any) => void;
}

/**
 * Options for creating a category command
 */
export interface CategoryCommandOptions {
  /** Override category name */
  name?: string;
  /** Override category description */
  description?: string;
  /** Command aliases */
  aliases?: string[];
  /** Custom options for specific commands */
  commandOptions?: Record<string, CliCommandOptions>;
  /** Whether to use category name as command prefix */
  usePrefix?: boolean;
}

/**
 * Parameter mapping options interface
 */
export interface ParameterMappingOptions {
  /** Whether to use this parameter as a command argument */
  asArgument?: boolean;
  /** Parameter alias (shorthand) */
  alias?: string;
  /** Custom CLI option name */
  optionName?: string;
  /** Custom description for help text */
  description?: string;
  /** Default value */
  defaultValue?: any;
}

/**
 * Manages customization options for CLI commands and categories
 */
export class CommandCustomizationManager {
  private customizations: Map<string, CliCommandOptions> = new Map();
  private categoryCustomizations: Map<CommandCategory, CategoryCommandOptions> = new Map();

  /**
   * Register command customization options
   */
  registerCommandCustomization(commandId: string, options: CliCommandOptions): void {
    this.customizations.set(commandId, options);
  }

  /**
   * Register category customization options
   */
  registerCategoryCustomization(category: CommandCategory, options: CategoryCommandOptions): void {
    this.categoryCustomizations.set(category, options);
  }

  /**
   * Get combined command options (defaults + customizations)
   */
  getCommandOptions(commandId: string): CliCommandOptions {
    const defaults: CliCommandOptions = {
      useFirstRequiredParamAsArgument: true,
      parameters: {},
      hidden: false,
      forceOptions: false,
    };

    return {
      ...defaults,
      ...this.customizations.get(commandId),
    };
  }

  /**
   * Get category customization options
   */
  getCategoryOptions(category: CommandCategory): CategoryCommandOptions {
    return this.categoryCustomizations.get(category) || {};
  }

  /**
   * Check if a command has customizations
   */
  hasCustomizations(commandId: string): boolean {
    return this.customizations.has(commandId);
  }

  /**
   * Check if a category has customizations
   */
  hasCategoryCustomizations(category: CommandCategory): boolean {
    return this.categoryCustomizations.has(category);
  }

  /**
   * Clear all customizations (useful for testing)
   */
  clearAllCustomizations(): void {
    this.customizations.clear();
    this.categoryCustomizations.clear();
  }
}

/**
 * Default instance for command customization management
 */
export const commandCustomizationManager = new CommandCustomizationManager();

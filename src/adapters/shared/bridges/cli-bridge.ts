/**
 * CLI Bridge (Legacy Compatibility Wrapper)
 *
 * This module provides backward compatibility for the original CLI bridge interface
 * while delegating to the new modular architecture underneath.
 * 
 * MIGRATION COMPLETE: 740 lines reduced to ~100 lines (86.5% reduction)
 * All functionality preserved through modular delegation pattern.
 */
import { Command } from "commander";
import { CommandCategory } from "../command-registry";
import {
  ModularCliCommandBridge,
  modularCliBridge,
  createModularCliBridge,
  registerCategorizedCliCommands as modularRegisterCategorizedCliCommands,
  type ModularCliBridgeConfig,
} from "./cli-bridge-modular";

// Re-export types for backward compatibility
export type {
  CliCommandOptions,
  CategoryCommandOptions,
  ParameterMappingOptions,
  CliExecutionContext,
} from "./cli";

/**
 * Legacy CLI Bridge Interface (Backward Compatibility)
 * 
 * ⚠️ DEPRECATED: This class is maintained for backward compatibility only.
 * New code should use ModularCliCommandBridge directly.
 * 
 * This wrapper delegates all functionality to the new modular architecture
 * while preserving the original API surface.
 */
export class CliCommandBridge {
  private modularBridge: ModularCliCommandBridge;

  constructor(config?: ModularCliBridgeConfig) {
    this.modularBridge = config ? createModularCliBridge(config) : modularCliBridge;
  }

  /**
   * Register command customization options
   * @deprecated Use ModularCliCommandBridge directly
   */
  registerCommandCustomization(commandId: string, options: any): void {
    return this.modularBridge.registerCommandCustomization(commandId, options);
  }

  /**
   * Register category customization options  
   * @deprecated Use ModularCliCommandBridge directly
   */
  registerCategoryCustomization(category: CommandCategory, options: any): void {
    return this.modularBridge.registerCategoryCustomization(category, options);
  }

  /**
   * Generate a CLI command from a shared command definition
   * @deprecated Use ModularCliCommandBridge directly
   */
  generateCommand(commandId: string, context?: { viaFactory?: boolean }): Command | null {
    return this.modularBridge.generateCommand(commandId, context);
  }

  /**
   * Generate CLI commands for all commands in a category
   * @deprecated Use ModularCliCommandBridge directly
   */
  generateCategoryCommand(
    category: CommandCategory,
    context?: { viaFactory?: boolean }
  ): Command | null {
    return this.modularBridge.generateCategoryCommand(category, context);
  }

  /**
   * Generate CLI commands for all categories
   * @deprecated Use ModularCliCommandBridge directly
   */
  generateAllCategoryCommands(program: Command, context?: { viaFactory?: boolean }): void {
    return this.modularBridge.generateAllCategoryCommands(program, context);
  }
}

/**
 * Default exported instance for the CLI bridge
 * 
 * @deprecated Use modularCliBridge from cli-bridge-modular.ts instead
 */
export const cliBridge = modularCliBridge;

/**
 * Register categorized CLI commands to a Commander.js program
 * 
 * @deprecated Use registerCategorizedCliCommands from cli-bridge-modular.ts instead
 */
export function registerCategorizedCliCommands(
  program: Command,
  categories: CommandCategory[],
  createSubcommands: boolean = true
): void {
  return modularRegisterCategorizedCliCommands(program, categories, createSubcommands);
}

// Export modular components for migration path
export {
  ModularCliCommandBridge,
  modularCliBridge,
  createModularCliBridge,
  registerCategorizedCliCommands as registerCategorizedCliCommandsModular,
} from "./cli-bridge-modular";

// Export all modular components for full access
export * from "./cli";
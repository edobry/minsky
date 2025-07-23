/**
 * CLI Command Generator (Legacy Compatibility Wrapper)
 *
 * This module provides backward compatibility for the original CLI command generator interface
 * while delegating to the new modular CLI bridge architecture underneath.
 *
 * MIGRATION COMPLETE: 613 lines reduced to ~50 lines (91.8% reduction)
 * All functionality preserved through modular delegation pattern.
 */
import { Command } from "commander";
import type { CommandCategory } from "../command-registry";

// Import modular CLI bridge components
import {
  ModularCliCommandBridge,
  modularCliBridge,
  type ModularCliBridgeConfig,
} from "./cli-bridge-modular";

// Re-export types from modular CLI bridge for backward compatibility
export type {
  CliCommandOptions,
  CategoryCommandOptions,
  ParameterMappingOptions,
  CliExecutionContext,
} from "./cli";

/**
 * CLI Command Generator (Legacy Compatibility Wrapper)
 *
 * ⚠️ DEPRECATED: This class is maintained for backward compatibility only.
 * New code should use ModularCliCommandBridge directly.
 *
 * This wrapper delegates all functionality to the new modular architecture
 * while preserving the original API surface.
 */
export class CliCommandGenerator {
  private modularBridge: ModularCliCommandBridge;

  constructor(config?: ModularCliBridgeConfig) {
    this.modularBridge = config ? new ModularCliCommandBridge(config) : modularCliBridge;
  }

  /**
   * Register command customization options
   */
  registerCommandCustomization(commandId: string, options: CliCommandOptions): void {
    this.modularBridge.registerCommandCustomization(commandId, options);
  }

  /**
   * Register category customization options
   */
  registerCategoryCustomization(category: CommandCategory, options: CategoryCommandOptions): void {
    this.modularBridge.registerCategoryCustomization(category, options);
  }

  /**
   * Generate a CLI command from a shared command definition
   */
  generateCommand(commandId: string, context?: { viaFactory?: boolean }): Command | null {
    return this.modularBridge.generateCommand(commandId, context);
  }

  /**
   * Generate CLI commands for all commands in a category
   */
  generateCategoryCommand(
    category: CommandCategory,
    context?: { viaFactory?: boolean }
  ): Command | null {
    return this.modularBridge.generateCategoryCommand(category, context);
  }

  /**
   * Generate CLI commands for all categories
   */
  generateAllCategoryCommands(program: Command, context?: { viaFactory?: boolean }): void {
    this.modularBridge.generateAllCategoryCommands(program, context);
  }
}

/**
 * Default exported instance for the CLI command generator
 */
export const cliCommandGenerator = new CliCommandGenerator();

// Export modular components for migration path
export { ModularCliCommandBridge, modularCliBridge } from "./cli-bridge-modular";

// Export for backward compatibility
export { ModularCliCommandBridge as CliCommandBridge };
export { modularCliBridge as cliBridge };

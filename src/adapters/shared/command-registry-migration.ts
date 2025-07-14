/**
 * Command Registry Migration Adapter
 *
 * This adapter provides backward compatibility with the legacy SharedCommand interface
 * while enabling gradual migration to the command registry.
 */

import { z } from "zod";
import {
  SharedCommand,
  SharedCommandRegistry,
  CommandDefinition,
  CommandParameterMap,
  CommandCategory,
  CommandExecutionContext,
} from "./legacy-command-registry.js";
import {
  SharedCommandRegistry as NewSharedCommandRegistry,
  CommandDefinition as NewCommandDefinition,
  SharedCommand as NewSharedCommand,
  createSharedCommandRegistry,
} from "./command-registry.js";
import { MinskyError } from "../../errors/index.js";

/**
 * Migration adapter that wraps both registries and provides compatibility
 */
export class CommandRegistryMigrationAdapter {
  private legacyRegistry: SharedCommandRegistry;
  private newRegistry: NewSharedCommandRegistry;
  private migratedCommands: Set<string> = new Set();

  constructor(legacyRegistry?: SharedCommandRegistry) {
    this.legacyRegistry = legacyRegistry || new SharedCommandRegistry();
    this.newRegistry = createSharedCommandRegistry();
  }

  /**
   * Register a command using the new registry (preferred)
   *
   * @param commandDef Command definition
   * @param options Registration options
   */
  registerCommand<
    T extends CommandParameterMap = CommandParameterMap,
    R = any,
  >(
    commandDef: NewCommandDefinition<T, R>,
    options: { allowOverwrite?: boolean } = {}
  ): void {
    this.newRegistry.registerCommand(commandDef, options);
    this.migratedCommands.add(commandDef.id);
  }

  /**
   * Register a command using the legacy registry (compatibility)
   *
   * @param commandDef Legacy command definition
   * @param options Registration options
   * @deprecated Use registerCommand instead
   */
  registerLegacyCommand<
    T extends CommandParameterMap = CommandParameterMap,
    R = any,
  >(
    commandDef: CommandDefinition<T, R>,
    options: { allowOverwrite?: boolean } = {}
  ): void {
    this.legacyRegistry.registerCommand(commandDef, options);
  }

  /**
   * Get a command by its identifier, preferring new registry
   *
   * @param id Command identifier
   * @returns Command definition or undefined if not found
   */
  getCommand(id: string): SharedCommand | NewSharedCommand | undefined {
    // Check new registry first
    if (this.migratedCommands.has(id)) {
      return this.newRegistry.getCommand(id);
    }
    
    // Fall back to legacy registry
    return this.legacyRegistry.getCommand(id);
  }

  /**
   * Get a command by its identifier from new registry
   *
   * @param id Command identifier
   * @returns Command definition or undefined if not found
   */
  getNewCommand(id: string): NewSharedCommand | undefined {
    if (this.migratedCommands.has(id)) {
      return this.newRegistry.getCommand(id);
    }
    return undefined;
  }

  /**
   * Check if a command has been migrated to the new registry
   *
   * @param id Command identifier
   * @returns True if command is in new registry
   */
  isCommandMigrated(id: string): boolean {
    return this.migratedCommands.has(id);
  }

  /**
   * Get the new registry instance
   *
   * @returns New command registry
   */
  getNewRegistry(): NewSharedCommandRegistry {
    return this.newRegistry;
  }

  /**
   * Get the legacy registry instance
   *
   * @returns Legacy command registry
   */
  getLegacyRegistry(): SharedCommandRegistry {
    return this.legacyRegistry;
  }
}

/**
 * Factory function to create a migration adapter
 *
 * @param legacyRegistry Optional existing legacy registry
 * @returns New migration adapter instance
 */
export function createCommandRegistryMigrationAdapter(
  legacyRegistry?: SharedCommandRegistry
): CommandRegistryMigrationAdapter {
  return new CommandRegistryMigrationAdapter(legacyRegistry);
} 

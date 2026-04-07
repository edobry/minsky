/**
 * CLI Command Factory
 *
 * Facade module that re-exports from focused sub-modules.
 * The actual implementation is split across:
 *   - core/cli-command-factory-core.ts — Factory class and singleton
 *   - setup/command-setup.ts — Initialization and customization wiring
 *   - customizations/ — Per-category CLI customizations
 *   - utilities/formatting-utilities.ts — Output formatting helpers
 *
 * Callers should use the `cliFactory` singleton (or `CliCommandFactory` class)
 * for command registration and customization.
 */

// Core factory class and singleton
export {
  CliCommandFactory,
  cliFactory,
  type CliFactoryConfig,
  type ValidCommandId,
} from "./core/cli-command-factory-core";

// Setup and initialization
export { setupCommonCommandCustomizations, initializeCliCommands } from "./setup/command-setup";

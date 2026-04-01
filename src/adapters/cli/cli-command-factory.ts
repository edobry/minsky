/**
 * CLI Command Factory
 *
 * Facade module that re-exports from focused sub-modules.
 * The actual implementation is split across:
 *   - core/cli-command-factory-core.ts — Factory class and singleton
 *   - setup/command-setup.ts — Initialization and customization wiring
 *   - customizations/ — Per-category CLI customizations
 *   - legacy/legacy-exports.ts — Deprecated function-based API
 *   - utilities/formatting-utilities.ts — Output formatting helpers
 *
 * This file preserves the original public API so existing imports continue to work.
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

// Legacy function exports (deprecated, kept for backward compatibility)
export {
  customizeCommand,
  customizeCategory,
  createCommand,
  createCategoryCommand,
  registerAllCommands,
} from "./legacy/legacy-exports";

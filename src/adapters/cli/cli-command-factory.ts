/**
 * CLI Command Factory - Import Hub
 * @migrated Converted to import hub after extracting components to focused modules
 * @architecture Follows the established modularization pattern
 *
 * Factory for creating CLI commands from shared commands using the CLI bridge.
 *
 * This is the ONLY recommended way to create CLI commands from shared commands.
 * It ensures proper customizations are applied and provides a consistent interface.
 */

// Export the core factory functionality
export { cliFactory, CliCommandFactory, type CliFactoryConfig, type ValidCommandId } from "./core/cli-command-factory-core";

// Export setup and initialization functions
export { setupCommonCommandCustomizations, initializeCliCommands } from "./setup/command-setup";

// Export legacy functions for backward compatibility
export {
  customizeCommand,
  customizeCategory,
  createCommand,
  createCategoryCommand,
  registerAllCommands,
} from "./legacy/legacy-exports";

// Export utility functions for external use
export {
  getBackendDisplayName,
  getSessionBackendDisplayName,
  formatDetectionCondition,
  sanitizeCredentials,
  formatConfigSection,
  formatConfigurationSources,
  formatResolvedConfiguration,
} from "./utilities/formatting-utilities";

// Export customization functions for advanced usage
export { getTasksCustomizations } from "./customizations/tasks-customizations";
export { getGitCustomizations } from "./customizations/git-customizations";
export { getSessionCustomizations } from "./customizations/session-customizations";
export { getConfigCustomizations, getSessiondbCustomizations } from "./customizations/config-customizations";

// Note: This file now serves as an import hub, providing access to all CLI factory
// functionality through focused, modularized components. The original 805-line file
// has been reduced to a clean interface with each responsibility separated into
// dedicated modules.
//
// File size reduction: 805 → ~40 lines (95% reduction)
//
// Extracted modules:
// - core/cli-command-factory-core.ts: Core factory class and singleton
// - customizations/tasks-customizations.ts: Task command configurations
// - customizations/git-customizations.ts: Git command configurations  
// - customizations/session-customizations.ts: Session command configurations
// - customizations/config-customizations.ts: Config and SessionDB configurations
// - utilities/formatting-utilities.ts: Display and formatting utilities
// - setup/command-setup.ts: Setup and initialization functions
// - legacy/legacy-exports.ts: Backward compatibility functions

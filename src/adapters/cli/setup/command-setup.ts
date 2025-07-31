/**
 * CLI Command Setup and Initialization
 * @migrated Extracted from cli-command-factory.ts for focused responsibility
 * @deprecated Use standardized CLI setup from integrations/standardized-cli-setup.ts instead
 */
import { Command } from "commander";
import { cliFactory, type CliFactoryConfig } from "../core/cli-command-factory-core";
import { getTasksCustomizations } from "../customizations/tasks-customizations";
import { getGitCustomizations } from "../customizations/git-customizations";
import { getSessionCustomizations } from "../customizations/session-customizations";
import {
  getConfigCustomizations,
  getSessiondbCustomizations,
} from "../customizations/config-customizations";
import {
  setupStandardizedCommandCustomizations,
  type StandardizedCliSetupConfig,
} from "../integrations/standardized-cli-setup";

/**
 * DEPRECATED: Helper function to setup legacy CLI command customizations
 * @deprecated Use setupStandardizedCommandCustomizations from integrations/standardized-cli-setup.ts instead
 * @param program Optional Command instance to apply customizations to
 */
export function setupCommonCommandCustomizations(program?: Command): void {
  // Initialize the factory if not already done
  if (!cliFactory["initialized"]) {
    cliFactory.initialize();
  }

  // Apply all category customizations (legacy patterns)
  const tasksConfig = getTasksCustomizations();
  cliFactory.customizeCategory(tasksConfig.category, tasksConfig.options);

  const gitConfig = getGitCustomizations();
  cliFactory.customizeCategory(gitConfig.category, gitConfig.options);

  const sessionConfig = getSessionCustomizations();
  cliFactory.customizeCategory(sessionConfig.category, sessionConfig.options);

  const configConfig = getConfigCustomizations();
  cliFactory.customizeCategory(configConfig.category, configConfig.options);

  const sessiondbConfig = getSessiondbCustomizations();
  cliFactory.customizeCategory(sessiondbConfig.category, sessiondbConfig.options);
}

/**
 * Initialize the CLI command system with standardized type composition patterns
 *
 * This is the recommended way to set up the CLI system using the standardized
 * patterns from Task #335.
 */
export function initializeCliCommands(
  program: Command,
  config?: Partial<CliFactoryConfig & StandardizedCliSetupConfig>
): void {
  // Initialize the factory
  cliFactory.initialize(config);

  // Setup standardized customizations using type composition patterns
  setupStandardizedCommandCustomizations(program, config);

  // Register all commands in the program
  cliFactory.registerAllCommands(program);
}

/**
 * DEPRECATED: Initialize CLI commands with legacy patterns
 *
 * @deprecated Use initializeCliCommands() instead, which uses standardized patterns
 */
export function initializeCliCommandsLegacy(
  program: Command,
  config?: Partial<CliFactoryConfig>
): void {
  // Initialize the factory
  cliFactory.initialize(config);

  // Setup legacy customizations (for backwards compatibility only)
  setupCommonCommandCustomizations(program);

  // Register all commands in the program
  cliFactory.registerAllCommands(program);
}

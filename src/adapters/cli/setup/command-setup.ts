/**
 * CLI Command Setup and Initialization
 * @migrated Extracted from cli-command-factory.ts for focused responsibility
 */
import { Command } from "commander";
import { cliFactory, type CliFactoryConfig } from "../core/cli-command-factory-core";
import { getTasksCustomizations } from "../customizations/tasks-customizations";
import { getGitCustomizations } from "../customizations/git-customizations";
import { getSessionCustomizations } from "../customizations/session-customizations";
import { getConfigCustomizations, getSessiondbCustomizations } from "../customizations/config-customizations";

/**
 * Helper function to setup common CLI command customizations
 * @param program Optional Command instance to apply customizations to
 */
export function setupCommonCommandCustomizations(program?: Command): void {
  // Initialize the factory if not already done
  if (!cliFactory["initialized"]) {
    cliFactory.initialize();
  }

  // Apply all category customizations
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
 * Initialize the CLI command system with proper customizations
 *
 * This is the recommended way to set up the CLI system.
 */
export function initializeCliCommands(program: Command, config?: Partial<CliFactoryConfig>): void {
  // Initialize the factory
  cliFactory.initialize(config);

  // Setup common customizations
  setupCommonCommandCustomizations(program);

  // Register all commands in the program
  cliFactory.registerAllCommands(program);
} 

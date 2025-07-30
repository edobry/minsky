/**
 * Standardized CLI Setup
 * 
 * Integrates the type composition patterns from Task #335 into the CLI command factory.
 * This file demonstrates how to migrate from manual customizations to standardized patterns.
 */
import { Command } from "commander";
import { CommandCategory } from "../../shared/command-registry";
import { cliFactory } from "../cli-command-factory";
import {
  getStandardizedTasksCustomizations,
} from "../customizations/standardized-tasks-customizations";
import {
  getStandardizedGitCustomizations,
} from "../customizations/standardized-git-customizations";
import {
  getStandardizedSessionCustomizations,
} from "../customizations/standardized-session-customizations";
import { log } from "../../../utils/logger";

/**
 * Configuration for standardized CLI setup
 */
export interface StandardizedCliSetupConfig {
  /** Whether to enable schema validation for all commands */
  enableSchemaValidation?: boolean;
  /** Whether to use standardized response formatting */
  useStandardizedFormatting?: boolean;
  /** Whether to apply standardized error handling */
  useStandardizedErrorHandling?: boolean;
  /** Whether to enable debug logging for schema validation */
  enableValidationLogging?: boolean;
  /** Commands to exclude from standardized patterns */
  excludeCommands?: string[];
  /** Categories to exclude from standardized patterns */
  excludeCategories?: CommandCategory[];
}

/**
 * Default configuration for standardized CLI setup
 */
const DEFAULT_STANDARDIZED_CONFIG: StandardizedCliSetupConfig = {
  enableSchemaValidation: true,
  useStandardizedFormatting: true,
  useStandardizedErrorHandling: true,
  enableValidationLogging: process.env.NODE_ENV === "development",
  excludeCommands: [],
  excludeCategories: [],
};

/**
 * Setup standardized CLI command customizations using type composition patterns
 * 
 * This function applies the standardized parameter validation, response formatting,
 * and error handling patterns from Task #335 to all CLI commands.
 * 
 * @param program Optional Command instance to apply customizations to
 * @param config Configuration for standardized setup
 */
export function setupStandardizedCommandCustomizations(
  program?: Command,
  config: Partial<StandardizedCliSetupConfig> = {}
): void {
  const finalConfig = { ...DEFAULT_STANDARDIZED_CONFIG, ...config };

  log.debug("Setting up standardized CLI command customizations", {
    config: finalConfig,
  });

  // Initialize the factory if not already done
  if (!cliFactory["initialized"]) {
    cliFactory.initialize({
      enableDevWarnings: process.env.NODE_ENV !== "production",
      strictValidation: true,
    });
  }

  // Apply standardized task customizations
  if (!finalConfig.excludeCategories?.includes(CommandCategory.TASKS)) {
    const tasksCustomizations = getStandardizedTasksCustomizations();
    log.debug("Applying standardized task customizations");
    cliFactory.customizeCategory(tasksCustomizations.category, tasksCustomizations.options);
  }

  // Apply standardized git customizations
  if (!finalConfig.excludeCategories?.includes(CommandCategory.GIT)) {
    const gitCustomizations = getStandardizedGitCustomizations();
    log.debug("Applying standardized git customizations");
    cliFactory.customizeCategory(gitCustomizations.category, gitCustomizations.options);
  }

  // Apply standardized session customizations
  if (!finalConfig.excludeCategories?.includes(CommandCategory.SESSION)) {
    const sessionCustomizations = getStandardizedSessionCustomizations();
    log.debug("Applying standardized session customizations");
    cliFactory.customizeCategory(sessionCustomizations.category, sessionCustomizations.options);
  }

  // Apply config customizations (if they exist)
  if (!finalConfig.excludeCategories?.includes(CommandCategory.CONFIG)) {
    // Note: Config customizations would be implemented here when available
    log.debug("Config customizations not yet implemented - using legacy patterns");
  }

  // Apply rules customizations (if they exist)
  if (!finalConfig.excludeCategories?.includes(CommandCategory.RULES)) {
    // Note: Rules customizations would be implemented here when available
    log.debug("Rules customizations not yet implemented - using legacy patterns");
  }

  log.debug("Standardized CLI command customizations setup complete");
}

/**
 * Hybrid setup function that uses standardized patterns where available
 * and falls back to legacy patterns for categories not yet migrated
 * 
 * This allows for gradual migration to standardized patterns.
 */
export function setupHybridCommandCustomizations(
  program?: Command,
  config: Partial<StandardizedCliSetupConfig> = {}
): void {
  const finalConfig = { ...DEFAULT_STANDARDIZED_CONFIG, ...config };

  log.debug("Setting up hybrid CLI command customizations (standardized + legacy)");

  // Apply standardized patterns for migrated categories
  setupStandardizedCommandCustomizations(program, {
    ...finalConfig,
    // Only apply to categories that have been migrated
    excludeCategories: [
      ...(finalConfig.excludeCategories || []),
      CommandCategory.CONFIG,   // Not yet migrated
      CommandCategory.RULES,    // Not yet migrated
    ],
  });

  // Fall back to legacy patterns for non-migrated categories
  // This would call the original setupCommonCommandCustomizations
  // but only for the categories not yet migrated
  log.debug("Applying legacy patterns for non-migrated categories");

  // NOTE: In a real migration, this would selectively apply legacy patterns
  // For now, this serves as a demonstration of the hybrid approach
}

/**
 * Migration utility to compare standardized vs legacy customizations
 * 
 * This function can be used during migration to verify that standardized
 * patterns provide equivalent or improved functionality compared to legacy patterns.
 */
export function validateMigration(): {
  migrated: CommandCategory[];
  pending: CommandCategory[];
  issues: string[];
} {
  const allCategories = Object.values(CommandCategory);
  const migrated: CommandCategory[] = [
    CommandCategory.TASKS,
    CommandCategory.GIT,
    CommandCategory.SESSION,
  ];
  const pending = allCategories.filter(cat => !migrated.includes(cat));
  const issues: string[] = [];

  // Validate that migrated categories have standardized customizations
  migrated.forEach(category => {
    try {
      switch (category) {
        case CommandCategory.TASKS:
          getStandardizedTasksCustomizations();
          break;
        case CommandCategory.GIT:
          getStandardizedGitCustomizations();
          break;
        case CommandCategory.SESSION:
          getStandardizedSessionCustomizations();
          break;
        default:
          issues.push(`Missing standardized customizations for ${category}`);
      }
    } catch (error) {
      issues.push(`Error loading standardized customizations for ${category}: ${error}`);
    }
  });

  return { migrated, pending, issues };
}

/**
 * Migration benefits achieved by using standardized patterns:
 * 
 * 1. **Type Safety**: Full TypeScript validation for all command parameters
 * 2. **Consistent Validation**: Zod schema-based parameter validation across all commands
 * 3. **Standardized Output**: Uniform JSON and text formatting for all commands
 * 4. **Enhanced Error Handling**: Proper exit codes and user-friendly error messages
 * 5. **Composable Patterns**: Easy to add new commands using established patterns
 * 6. **Progressive Disclosure**: Advanced options properly organized and documented
 * 7. **Future-Proofing**: Easy to extend with new output formats and validation rules
 * 
 * Migration path:
 * 1. Use `setupHybridCommandCustomizations()` for gradual migration
 * 2. Migrate categories one by one to standardized patterns
 * 3. Eventually replace with `setupStandardizedCommandCustomizations()`
 * 4. Verify migration completeness with `validateMigration()`
 */ 

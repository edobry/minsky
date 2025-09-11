/**
 * Persistence Commands Module
 *
 * Modular persistence commands using DatabaseCommand pattern.
 * Extracted from the monolithic persistence.ts file for better maintainability.
 */

export { PersistenceMigrateCommand } from "./persistence-migrate-command";
export { PersistenceCheckCommand } from "./persistence-check-command";

/**
 * Export all persistence commands as an array for easy registration
 */
import { PersistenceMigrateCommand } from "./persistence-migrate-command";
import { PersistenceCheckCommand } from "./persistence-check-command";

export const persistenceCommands = [new PersistenceMigrateCommand(), new PersistenceCheckCommand()];

/**
 * MIGRATION NOTES:
 *
 * This module replaces the monolithic persistence.ts file with a modular structure:
 *
 * OLD STRUCTURE:
 * - Single 1500+ line file with inline command definitions
 * - Direct PersistenceService.getProvider() calls
 * - Complex helper functions mixed with command logic
 *
 * NEW STRUCTURE:
 * - Separate files for each command
 * - DatabaseCommand pattern with provider injection
 * - Modular helper methods
 * - Clean separation of concerns
 *
 * BENEFITS:
 * - Easier to test individual commands
 * - Better code organization
 * - Type safety with DatabaseCommand pattern
 * - Automatic provider initialization
 * - No manual PersistenceService calls
 */

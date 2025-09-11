/**
 * Session Commands Module - DatabaseCommand Pattern
 *
 * Exports all session commands using the DatabaseCommand pattern with provider injection.
 * Replaces the old factory function pattern with direct class instantiation.
 */

// Import all basic commands
import {
  SessionListCommand,
  SessionGetCommand,
  SessionStartCommand,
  SessionDirCommand,
  SessionSearchCommand,
} from "./basic-commands";

// Import all management commands
import {
  SessionDeleteCommand,
  SessionUpdateCommand,
  SessionMigrateBackendCommand,
} from "./management-commands";

// Import all workflow commands
import {
  SessionCommitCommand,
  SessionApproveCommand,
  SessionInspectCommand,
  SessionReviewCommand,
} from "./workflow-commands";

// Import specialized commands
import { SessionRepairCommand } from "./repair-command";
import { SessionConflictsCommand } from "./conflicts-command";
import { SessionEditFileCommand } from "./file-commands";

// Import PR subcommands
import {
  SessionPrCreateCommand,
  SessionPrEditCommand,
  SessionPrListCommand,
  SessionPrGetCommand,
  SessionPrOpenCommand,
} from "./pr-subcommand-commands";

// Export all command classes
export {
  // Basic commands
  SessionListCommand,
  SessionGetCommand,
  SessionStartCommand,
  SessionDirCommand,
  SessionSearchCommand,
  
  // Management commands
  SessionDeleteCommand,
  SessionUpdateCommand,
  SessionMigrateBackendCommand,
  
  // Workflow commands
  SessionCommitCommand,
  SessionApproveCommand,
  SessionInspectCommand,
  SessionReviewCommand,
  
  // Specialized commands
  SessionRepairCommand,
  SessionConflictsCommand,
  SessionEditFileCommand,
  
  // PR subcommands
  SessionPrCreateCommand,
  SessionPrEditCommand,
  SessionPrListCommand,
  SessionPrGetCommand,
  SessionPrOpenCommand,
};

// Export parameter definitions
export * from "./session-parameters";

/**
 * Array of all session commands for registration (DatabaseCommand pattern)
 */
export const allSessionCommands = [
  // Basic commands (5)
  new SessionListCommand(),
  new SessionGetCommand(),
  new SessionStartCommand(),
  new SessionDirCommand(),
  new SessionSearchCommand(),

  // Management commands (3)
  new SessionDeleteCommand(),
  new SessionUpdateCommand(),
  new SessionMigrateBackendCommand(),

  // Workflow commands (4)
  new SessionCommitCommand(),
  new SessionApproveCommand(),
  new SessionInspectCommand(),
  new SessionReviewCommand(),

  // Specialized commands (3)
  new SessionRepairCommand(),
  new SessionConflictsCommand(),
  new SessionEditFileCommand(),

  // PR subcommands (5)
  new SessionPrCreateCommand(),
  new SessionPrEditCommand(),
  new SessionPrListCommand(),
  new SessionPrGetCommand(),
  new SessionPrOpenCommand(),
];

/**
 * Total count: 20 session commands using DatabaseCommand pattern
 */
export const totalSessionCommands = allSessionCommands.length;

/**
 * Registration function for all session commands
 */
export function registerSessionCommands() {
  // This is now handled by the main command registry using allSessionCommands array
  // No longer needed as commands are registered via DatabaseCommand pattern
  console.warn("registerSessionCommands() is deprecated - commands are auto-registered via DatabaseCommand pattern");
}

/**
 * Temporary compatibility export for setupSessionCommandRegistry
 * @deprecated Use allSessionCommands array with DatabaseCommand pattern instead
 */
export async function setupSessionCommandRegistry(deps?: any) {
  console.warn("setupSessionCommandRegistry() is deprecated - use allSessionCommands with DatabaseCommand pattern instead");
  return null;
}

/**
 * Temporary compatibility export for createAllSessionCommands  
 * @deprecated Use allSessionCommands array with DatabaseCommand pattern instead
 */
export async function createAllSessionCommands(deps?: any) {
  console.warn("createAllSessionCommands() is deprecated - use allSessionCommands array with DatabaseCommand pattern instead");
  return allSessionCommands;
}

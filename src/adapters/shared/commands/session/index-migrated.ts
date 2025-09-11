/**
 * Session Commands Module (Migrated to DatabaseCommand)
 *
 * Exports migrated session commands that use DatabaseCommand pattern.
 */

// Import migrated commands
import {
  SessionListCommand,
  SessionGetCommand,
  SessionStartCommand,
  SessionDirCommand,
  SessionSearchCommand,
} from "./basic-commands-migrated";

import {
  SessionDeleteCommand,
  SessionUpdateCommand,
  SessionMigrateBackendCommand,
} from "./management-commands-migrated";

import {
  SessionCommitCommand,
  SessionApproveCommand,
  SessionInspectCommand,
  SessionReviewCommand,
} from "./workflow-commands-migrated";

// Export all migrated session commands
export const sessionCommandsMigrated = [
  // Basic commands
  new SessionListCommand(),
  new SessionGetCommand(),
  new SessionStartCommand(),
  new SessionDirCommand(),
  new SessionSearchCommand(),

  // Management commands
  new SessionDeleteCommand(),
  new SessionUpdateCommand(),
  new SessionMigrateBackendCommand(),

  // Workflow commands
  new SessionCommitCommand(),
  new SessionApproveCommand(),
  new SessionInspectCommand(),
  new SessionReviewCommand(),

  // Note: PR subcommands would need to be migrated separately
  // as they are complex and may have different patterns
];

// Export individual command classes for direct use
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
};

// Export parameter definitions
export * from "./session-parameters";


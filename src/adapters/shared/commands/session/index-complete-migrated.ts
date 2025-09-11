/**
 * Complete Session Commands - All DatabaseCommand Migrations
 *
 * This file exports ALL migrated session commands using the DatabaseSessionCommand pattern.
 * It includes all the existing migrated commands plus the additional specialized commands.
 */

// Import existing migrated commands from the main migrated index
import { sessionCommandsMigrated } from "./index-migrated";

// Import specialized commands
import { SessionRepairCommand } from "./repair-command-migrated";
import { SessionConflictsCommand } from "./conflicts-command-migrated";
import { SessionEditFileCommand } from "./file-commands-migrated";

// Import PR subcommands
import {
  SessionPrCreateCommand,
  SessionPrEditCommand,
  SessionPrListCommand,
  SessionPrGetCommand,
  SessionPrOpenCommand,
} from "./pr-subcommand-commands-migrated";

/**
 * Array of all migrated session commands for registration
 */
export const allSessionCommandsMigrated = [
  // Existing migrated commands (basic, management, workflow - 12 commands)
  ...sessionCommandsMigrated,

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
 * Total count: 20 session commands fully migrated to DatabaseSessionCommand pattern
 * - 12 existing migrated commands (basic, management, workflow)
 * - 8 additional specialized and PR commands
 */
export const totalMigratedSessionCommands = allSessionCommandsMigrated.length;

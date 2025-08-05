/**
 * Session Commands Module
 *
 * Exports for all modularized session command components.
 * Part of the modularization effort from session.ts.
 */

// Base command infrastructure
import { SessionCommandRegistry } from "./base-session-command";
import type { SessionCommandDependencies } from "./base-session-command";
export {
  BaseSessionCommand,
  SessionCommandRegistry,
  sessionCommandRegistry,
} from "./base-session-command";
export type { SessionCommandDependencies, BaseSessionCommandParams } from "./base-session-command";

// Parameter definitions
export * from "./session-parameters";

// Basic commands (re-export)
export {
  SessionListCommand,
  SessionGetCommand,
  SessionStartCommand,
  SessionDirCommand,
  createSessionListCommand,
  createSessionGetCommand,
  createSessionStartCommand,
  createSessionDirCommand,
} from "./basic-commands";

// Import factory functions for internal use
import {
  createSessionListCommand,
  createSessionGetCommand,
  createSessionStartCommand,
  createSessionDirCommand,
} from "./basic-commands";

// Management commands (re-export)
export {
  SessionDeleteCommand,
  SessionUpdateCommand,
  createSessionDeleteCommand,
  createSessionUpdateCommand,
} from "./management-commands";

// Import management factory functions for internal use
import { createSessionDeleteCommand, createSessionUpdateCommand } from "./management-commands";

// Workflow commands (re-export)
export {
  SessionApproveCommand,
  SessionInspectCommand,
  createSessionApproveCommand,
  createSessionInspectCommand,
  // Export new PR subcommands instead of single SessionPrCommand
  SessionPrCreateCommand,
  SessionPrListCommand,
  SessionPrGetCommand,
  createSessionPrCreateCommand,
  createSessionPrListCommand,
  createSessionPrGetCommand,
} from "./workflow-commands";

// Import conflicts command
import { createSessionConflictsCommand } from "./conflicts-command";

// Import workflow factory functions for internal use
import {
  createSessionApproveCommand,
  createSessionInspectCommand,
  // Import new PR subcommand factories
  createSessionPrCreateCommand,
  createSessionPrListCommand,
  createSessionPrGetCommand,
  createSessionPrApproveCommand,
  createSessionPrMergeCommand,
} from "./workflow-commands";

// Factory for creating all session commands
export async function createAllSessionCommands(deps?: SessionCommandDependencies) {
  // Use dynamic imports to avoid circular dependency issues
  const basicCommands = await import("./basic-commands");
  const managementCommands = await import("./management-commands");
  const workflowCommands = await import("./workflow-commands");

  const {
    createSessionListCommand,
    createSessionGetCommand,
    createSessionStartCommand,
    createSessionDirCommand,
  } = basicCommands;

  const { createSessionDeleteCommand, createSessionUpdateCommand } = managementCommands;

  // Updated to use PR subcommands instead of single pr command
  const {
    createSessionCommitCommand,
    createSessionApproveCommand,
    createSessionInspectCommand,
    createSessionPrCreateCommand,
    createSessionPrListCommand,
    createSessionPrGetCommand,
  } = workflowCommands;

  return {
    // Basic commands
    list: createSessionListCommand(deps),
    get: createSessionGetCommand(deps),
    start: createSessionStartCommand(deps),
    dir: createSessionDirCommand(deps),

    // Management commands
    delete: createSessionDeleteCommand(deps),
    update: createSessionUpdateCommand(deps),

    // Workflow commands
    commit: createSessionCommitCommand(deps),
    approve: createSessionApproveCommand(deps),
    inspect: createSessionInspectCommand(deps),

    // PR subcommands replace single pr command
    prCreate: createSessionPrCreateCommand(deps),
    prList: createSessionPrListCommand(deps),
    prGet: createSessionPrGetCommand(deps),
    prApprove: createSessionPrApproveCommand(deps),
    prMerge: createSessionPrMergeCommand(deps),

    // Utility commands
    conflicts: createSessionConflictsCommand(deps),
  };
}

// Registry setup function
export async function setupSessionCommandRegistry(
  deps?: SessionCommandDependencies
): Promise<SessionCommandRegistry> {
  const registry = new SessionCommandRegistry();
  const commands = await createAllSessionCommands(deps);

  // Register all commands
  registry.register("session.list", commands.list);
  registry.register("session.get", commands.get);
  registry.register("session.start", commands.start);
  registry.register("session.dir", commands.dir);
  registry.register("session.delete", commands.delete);
  registry.register("session.update", commands.update);
  registry.register("session.commit", commands.commit);
  // NOTE: session.approve removed in favor of session.pr.approve (Task #358)
  registry.register("session.inspect", commands.inspect);
  registry.register("session.conflicts", commands.conflicts);

  // Register PR subcommands instead of single session.pr
  registry.register("session.pr.create", commands.prCreate);
  registry.register("session.pr.list", commands.prList);
  registry.register("session.pr.get", commands.prGet);
  registry.register("session.pr.approve", commands.prApprove);
  registry.register("session.pr.merge", commands.prMerge);

  return registry;
}

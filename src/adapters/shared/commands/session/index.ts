/**
 * Session Commands Module
 *
 * Exports for all modularized session command components.
 * Part of the modularization effort from session.ts.
 */

// Base command infrastructure
export {
  BaseSessionCommand,
  SessionCommandRegistry,
  sessionCommandRegistry,
} from "./base-session-command";
export type { SessionCommandDependencies, BaseSessionCommandParams } from "./base-session-command";

// Parameter definitions
export * from "./session-parameters";

// Basic commands
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

// Management commands
export {
  SessionDeleteCommand,
  SessionUpdateCommand,
  createSessionDeleteCommand,
  createSessionUpdateCommand,
} from "./management-commands";

// Workflow commands
export {
  SessionApproveCommand,
  SessionPrCommand,
  SessionInspectCommand,
  createSessionApproveCommand,
  createSessionPrCommand,
  createSessionInspectCommand,
} from "./workflow-commands";

// Factory for creating all session commands
export function createAllSessionCommands(deps?: SessionCommandDependencies) {
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
    approve: createSessionApproveCommand(deps),
    pr: createSessionPrCommand(deps),
    inspect: createSessionInspectCommand(deps),
  };
}

// Registry setup function
export function setupSessionCommandRegistry(
  deps?: SessionCommandDependencies
): SessionCommandRegistry {
  const registry = new SessionCommandRegistry();
  const commands = createAllSessionCommands(deps);

  // Register all commands
  registry.register("session.list", commands.list);
  registry.register("session.get", commands.get);
  registry.register("session.start", commands.start);
  registry.register("session.dir", commands.dir);
  registry.register("session.delete", commands.delete);
  registry.register("session.update", commands.update);
  registry.register("session.approve", commands.approve);
  registry.register("session.pr", commands.pr);
  registry.register("session.inspect", commands.inspect);

  return registry;
}

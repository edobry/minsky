/**
 * Session Command Registration
 *
 * Constructs and registers all session commands (and changeset aliases)
 * in the shared command registry.
 */
import { type SessionCommandDependencies } from "./session/types";
import {
  createSessionListCommand,
  createSessionGetCommand,
  createSessionStartCommand,
  createSessionDirCommand,
  createSessionSearchCommand,
} from "./session/basic-commands";
import {
  createSessionDeleteCommand,
  createSessionUpdateCommand,
  createSessionMigrateBackendCommand,
} from "./session/management-commands";
import {
  createSessionCommitCommand,
  createSessionInspectCommand,
  createSessionReviewCommand,
  createSessionPrApproveCommand,
  createSessionPrMergeCommand,
  createSessionPrCreateCommand,
  createSessionPrEditCommand,
  createSessionPrListCommand,
  createSessionPrGetCommand,
  createSessionPrOpenCommand,
} from "./session/workflow-commands";
import { createSessionConflictsCommand } from "./session/conflicts-command";
import { createSessionRepairCommand } from "./session/repair-command";
import { createSessionEditFileCommand } from "./session/file-commands";
import { registerSessionChangesetCommands } from "./session/changeset-aliases";
import { sharedCommandRegistry, type CommandDefinition } from "../command-registry";

/**
 * Register all session commands (including changeset aliases) in the shared
 * command registry.
 */
export async function registerSessionCommands(
  partialDeps?: Partial<SessionCommandDependencies>
): Promise<void> {
  const { getSharedSessionProvider } = await import(
    "../../../domain/session/session-provider-cache"
  );
  const { createSessionDeps } = await import("../../../domain/session/session-service");
  const sessionProvider = partialDeps?.sessionProvider ?? (await getSharedSessionProvider());
  const deps: SessionCommandDependencies = await createSessionDeps(sessionProvider);

  const commands: CommandDefinition[] = [
    // Basic
    createSessionListCommand(deps),
    createSessionGetCommand(deps),
    createSessionStartCommand(deps),
    createSessionDirCommand(deps),
    createSessionSearchCommand(deps),

    // Management
    createSessionDeleteCommand(deps),
    createSessionUpdateCommand(deps),
    createSessionMigrateBackendCommand(deps),

    // Workflow
    createSessionCommitCommand(deps),
    // NOTE: session.approve removed in favor of session.pr.approve (Task #358)
    createSessionInspectCommand(deps),
    createSessionReviewCommand(deps),

    // PR subcommands
    createSessionPrCreateCommand(deps),
    createSessionPrEditCommand(deps),
    createSessionPrListCommand(deps),
    createSessionPrGetCommand(deps),
    createSessionPrOpenCommand(deps),
    createSessionPrApproveCommand(deps),
    createSessionPrMergeCommand(deps),

    // Utility
    createSessionConflictsCommand(deps),
    createSessionRepairCommand(deps),

    // File
    createSessionEditFileCommand(deps),
  ];

  for (const cmd of commands) {
    sharedCommandRegistry.registerCommand(cmd);
  }

  registerSessionChangesetCommands();
}

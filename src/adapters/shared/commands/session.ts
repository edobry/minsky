/**
 * Session Command Registration
 *
 * Constructs and registers all session commands (and changeset aliases)
 * in the shared command registry.
 */
import {
  type SessionCommandDependencies,
  createSessionListCommand,
  createSessionGetCommand,
  createSessionStartCommand,
  createSessionDirCommand,
  createSessionSearchCommand,
  createSessionDeleteCommand,
  createSessionUpdateCommand,
  createSessionMigrateBackendCommand,
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
  createSessionConflictsCommand,
  createSessionRepairCommand,
  createSessionEditFileCommand,
  registerSessionChangesetCommands,
} from "./session/";
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
  const sessionProvider = partialDeps?.sessionProvider ?? (await getSharedSessionProvider());
  const deps: SessionCommandDependencies = { sessionProvider };

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

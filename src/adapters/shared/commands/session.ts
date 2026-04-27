/**
 * Session Command Registration
 *
 * Constructs and registers all session commands (and changeset aliases)
 * in the shared command registry.
 */
import type { AppContainerInterface } from "../../../composition/types";
import { type SessionCommandDependencies, type LazySessionDeps } from "./session/types";
import {
  createSessionListCommand,
  createSessionGetCommand,
  createSessionStartCommand,
  createSessionDirCommand,
  createSessionSearchCommand,
  createSessionExecCommand,
} from "./session/basic-commands";
import {
  createSessionDeleteCommand,
  createSessionUpdateCommand,
  createSessionMigrateBackendCommand,
  createSessionMigrateCommand,
} from "./session/management-commands";
import { createSessionCleanupCommand } from "./session/cleanup-command";
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
  createSessionPrChecksCommand,
  createSessionPrWaitForReviewCommand,
  createSessionPrReviewContextCommand,
  createSessionPrReviewSubmitCommand,
  createSessionPrReviewDismissCommand,
} from "./session/workflow-commands";
import { createSessionConflictsCommand } from "./session/conflicts-command";
import { createSessionRepairCommand } from "./session/repair-command";
import { createSessionEditFileCommand } from "./session/file-commands";
import { createSessionGeneratePromptCommand } from "./session/prompt-command";
import { registerSessionChangesetCommands } from "./session/changeset-aliases";
import { sharedCommandRegistry, type CommandDefinition } from "../command-registry";

/**
 * Register all session commands (including changeset aliases) in the shared
 * command registry.
 */
export async function registerSessionCommands(
  _partialDeps?: Partial<SessionCommandDependencies>,
  container?: AppContainerInterface
): Promise<void> {
  // Lazy resolver: defers persistence initialization and domain module loading
  // to first command execution. CLI bootstrap only registers metadata.
  let cachedDeps: SessionCommandDependencies | null = null;
  const getDeps: LazySessionDeps = async () => {
    if (cachedDeps) return cachedDeps;
    if (!container?.has("sessionDeps")) {
      throw new Error(
        "DI container missing 'sessionDeps'. Ensure container.initialize() was called before command execution."
      );
    }
    cachedDeps = container.get("sessionDeps");
    return cachedDeps;
  };

  const commands: CommandDefinition[] = [
    // Basic
    createSessionListCommand(getDeps),
    createSessionGetCommand(getDeps),
    createSessionStartCommand(getDeps),
    createSessionDirCommand(getDeps),
    createSessionSearchCommand(getDeps),
    createSessionExecCommand(getDeps),

    // Management
    createSessionDeleteCommand(getDeps),
    createSessionUpdateCommand(getDeps),
    createSessionMigrateBackendCommand(getDeps),
    createSessionCleanupCommand(getDeps),

    // Workflow
    createSessionCommitCommand(getDeps),
    // NOTE: session.approve removed in favor of session.pr.approve (Task #358)
    createSessionInspectCommand(getDeps),
    createSessionReviewCommand(getDeps),

    // PR subcommands
    createSessionPrCreateCommand(getDeps),
    createSessionPrEditCommand(getDeps),
    createSessionPrListCommand(getDeps),
    createSessionPrGetCommand(getDeps),
    createSessionPrOpenCommand(getDeps),
    createSessionPrApproveCommand(getDeps),
    createSessionPrMergeCommand(getDeps),
    createSessionPrChecksCommand(getDeps),
    createSessionPrWaitForReviewCommand(getDeps),
    createSessionPrReviewContextCommand(getDeps),
    createSessionPrReviewSubmitCommand(getDeps),
    createSessionPrReviewDismissCommand(getDeps),

    // Migration
    createSessionMigrateCommand(getDeps),

    // Utility
    createSessionConflictsCommand(getDeps),
    createSessionRepairCommand(getDeps),
    createSessionGeneratePromptCommand(getDeps),

    // File
    createSessionEditFileCommand(getDeps),
  ];

  for (const cmd of commands) {
    sharedCommandRegistry.registerCommand(cmd);
  }

  registerSessionChangesetCommands();
}

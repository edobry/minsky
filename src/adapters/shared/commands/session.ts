/**
 * Session Command Registration
 *
 * Constructs and registers all session commands in the shared command
 * registry.
 */
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { PersistenceProvider } from "@minsky/domain/persistence/types";
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
  createSessionPrCloseCommand,
  createSessionPrListCommand,
  createSessionPrGetCommand,
  createSessionPrOpenCommand,
  createSessionPrChecksCommand,
  createSessionPrWaitForReviewCommand,
  createSessionPrDriveCommand,
  createSessionPrReviewContextCommand,
  createSessionPrReviewSubmitCommand,
  createSessionPrReviewDismissCommand,
  createSessionPrReviewThreadResolveCommand,
  createSessionPrCheckRunSubmitCommand,
} from "./session/workflow-commands";
import { createSessionConflictsCommand } from "./session/conflicts-command";
import { createSessionRepairCommand } from "./session/repair-command";
import { createSessionEditFileCommand } from "./session/file-commands";
import { createSessionGeneratePromptCommand } from "./session/prompt-command";
import { createApplyPostMergeStateSyncCommand } from "./session/apply-post-merge-state-sync-command";
import { sharedCommandRegistry, type CommandDefinition } from "../command-registry";

/**
 * Register all session commands in the shared command registry.
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

  // Optional (non-throwing) persistence provider for best-effort event emission
  // (mt#2487 session.started). Returns undefined when persistence isn't wired
  // (e.g., CLI without a DB) so the emit skips silently rather than throwing.
  //
  // Injected as a separate getter — mirroring how the task commands receive
  // `getPersistenceProvider` (src/adapters/shared/commands/tasks/registry-setup.ts)
  // — rather than widening the domain `SessionDeps` bundle. SessionDeps is the
  // session-service dependency superset (gitService/taskService/workspaceUtils/…);
  // persistence is an adapter-composition concern for this best-effort emit and is
  // deliberately kept out of that domain type, matching the tasks-command convention.
  const getOptionalPersistenceProvider = (): PersistenceProvider | undefined => {
    if (!container?.has("persistence")) return undefined;
    return container.get("persistence") as PersistenceProvider;
  };

  const commands: CommandDefinition[] = [
    // Basic
    createSessionListCommand(getDeps, getOptionalPersistenceProvider),
    createSessionGetCommand(getDeps),
    createSessionStartCommand(getDeps, getOptionalPersistenceProvider),
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
    createSessionPrCloseCommand(getDeps),
    createSessionPrMergeCommand(getDeps),
    createSessionPrChecksCommand(getDeps),
    createSessionPrWaitForReviewCommand(getDeps),
    createSessionPrDriveCommand(getDeps),
    createSessionPrReviewContextCommand(getDeps),
    createSessionPrReviewSubmitCommand(getDeps),
    createSessionPrReviewDismissCommand(getDeps),
    createSessionPrReviewThreadResolveCommand(getDeps),
    createSessionPrCheckRunSubmitCommand(getDeps),

    // Migration
    createSessionMigrateCommand(getDeps),

    // Utility
    createSessionConflictsCommand(getDeps),
    createSessionRepairCommand(getDeps),
    createSessionGeneratePromptCommand(getDeps),

    // At-merge state sync (webhook + sweeper + repair-pass entry point)
    createApplyPostMergeStateSyncCommand(getDeps),

    // File
    createSessionEditFileCommand(getDeps),
  ];

  for (const cmd of commands) {
    sharedCommandRegistry.registerCommand(cmd);
  }
}

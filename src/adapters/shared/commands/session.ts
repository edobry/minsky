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
import { createSessionPsCommand, createSessionAttachedCommand } from "./session/ps-command";
import { createSessionFocusCommand, createSessionGotoCommand } from "./session/focus-command";
import { createSessionBindingsRefreshCommand } from "./session/bindings-command";
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
import { sharedCommandRegistry, type AnyCommandDefinition } from "../command-registry";

/**
 * Register all session commands in the shared command registry.
 */
export async function registerSessionCommands(
  _partialDeps?: Partial<SessionCommandDependencies>,
  container?: AppContainerInterface
): Promise<void> {
  // Lazy resolver: defers persistence initialization and domain module loading
  // to first command execution. CLI bootstrap only registers metadata.
  //
  // Resolved PER CALL, never memoized (mt#4379). This closure outlives every
  // command — `registerSessionCommands` runs once at bootstrap — so caching the
  // bundle here pinned it for the life of the process. When `sessionDeps` was
  // built during a transient Postgres outage it carried a zero-backend
  // `taskService`, and `session_start` then served that frozen bundle for 20+
  // hours while every per-call resolver in the same process healed normally.
  //
  // Two reasons the cache cannot come back as an optimization:
  //
  //   1. `container.get()` is the ACTUATION path for recovery, not merely a
  //      lookup. It calls `retryDeferred()` on any placeholder-backed key, and
  //      `PersistenceService.getProviderWithRetry` is explicitly "usage-gated,
  //      not time-gated: nothing runs unless something calls this" — there is no
  //      background poller by design (mt#3751). Caching the result therefore
  //      does not just risk staleness; it starves the self-heal of its only
  //      trigger.
  //   2. The cost it saves is noise: a tsyringe resolve is sub-microsecond
  //      against a command that does file and network I/O.
  //
  // This matches how the same bundle is already consumed elsewhere —
  // `buildSessionDirResolver` (src/adapters/shared/commands/validate.ts)
  // resolves `sessionDeps` fresh inside its returned closure — and how every
  // task command resolves its dependencies
  // (src/adapters/shared/commands/tasks/registry-setup.ts).
  //
  // If a cache is ever genuinely needed here, it must be keyed to a container
  // lifecycle epoch with a stable-across-construction check (the shape of
  // `createEpochKeyedCache` in src/cockpit/shared-persistence.ts), NOT a bare
  // memo: a bare re-read still has a torn window, and this repo has already had
  // eight module-level caches hold provider-derived handles with no epoch check.
  const getDeps: LazySessionDeps = async () => {
    if (!container?.has("sessionDeps")) {
      throw new Error(
        "DI container missing 'sessionDeps'. Ensure container.initialize() was called before command execution."
      );
    }
    return container.get("sessionDeps");
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

  const commands: AnyCommandDefinition[] = [
    // Basic
    createSessionListCommand(getDeps, getOptionalPersistenceProvider),
    createSessionGetCommand(getDeps, getOptionalPersistenceProvider),
    createSessionStartCommand(getDeps, getOptionalPersistenceProvider),
    createSessionDirCommand(getDeps),
    createSessionSearchCommand(getDeps),
    createSessionExecCommand(getDeps),
    createSessionPsCommand(getDeps, getOptionalPersistenceProvider),
    createSessionAttachedCommand(getDeps, getOptionalPersistenceProvider),
    createSessionFocusCommand(getDeps, getOptionalPersistenceProvider),
    createSessionGotoCommand(getDeps, getOptionalPersistenceProvider),
    createSessionBindingsRefreshCommand(getDeps, getOptionalPersistenceProvider),

    // Management
    createSessionDeleteCommand(getDeps, getOptionalPersistenceProvider),
    createSessionUpdateCommand(getDeps),
    createSessionMigrateBackendCommand(getDeps),
    createSessionCleanupCommand(getDeps, getOptionalPersistenceProvider),

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

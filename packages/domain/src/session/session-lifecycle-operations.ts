import { ResourceNotFoundError, ValidationError } from "../errors/index";
import { taskIdSchema as TaskIdSchema } from "../schemas/common";
import type {
  SessionGetParams,
  SessionListParams,
  SessionDeleteParams,
  SessionDirParams,
} from "../schemas/session";
import { resolveSessionContextWithFeedback } from "./session-context-resolver";
import { getCurrentSessionContext } from "../workspace";
import type { SessionProviderInterface, Session } from "./";
import { deriveSessionLiveness, SessionStatus } from "./types";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "../errors";
import { rmSync, existsSync } from "node:fs";
import { getSessionsDir } from "@minsky/shared/paths";
import type { GitServiceInterface } from "../git/types";
import { taskIdToBranchName } from "../tasks/task-id";
import type { PersistenceProvider } from "../persistence/types";
import { checkWorkspaceGitStateForDelete } from "./session-workspace-git-state-guard";
import {
  resolveDestructiveOverride,
  isValidDestructiveOverride,
  recordDestructiveOverride,
} from "../safety/destructive-override";

/**
 * Gets session details based on parameters
 * Using proper dependency injection for better testability
 * Now includes auto-detection capabilities via unified session context resolver
 */
export async function getSessionImpl(
  params: SessionGetParams,
  deps: {
    sessionDB: SessionProviderInterface;
  }
): Promise<Session | null> {
  const { sessionId, task, repo } = params;

  try {
    // Use unified session context resolver with auto-detection support
    const resolvedContext = await resolveSessionContextWithFeedback({
      sessionId,
      task: task,
      repo: repo,
      sessionProvider: deps.sessionDB,
      allowAutoDetection: true,
    });

    // Get the session details using the resolved session ID
    const session = await deps.sessionDB.getSession(resolvedContext.sessionId);
    if (!session) return null;
    const liveness = deriveSessionLiveness(session);
    return { ...session, liveness } as Session;
  } catch (error) {
    // If error is about missing session requirements, provide better user guidance
    if (error instanceof ValidationError) {
      throw new ResourceNotFoundError(
        "No session detected. Please provide a session ID (--sessionId), task ID (--task), or run this command from within a session workspace."
      );
    }
    throw error;
  }
}

/**
 * Lists sessions based on parameters, with pagination and ordering pushed
 * down to the storage layer so we never load every session record into memory.
 *
 * Default ordering is by recency (lastActivityAt desc, falling back to
 * createdAt desc) so the most recently-touched sessions appear first.
 */
export async function listSessionsImpl(
  params: SessionListParams,
  deps: {
    sessionDB: SessionProviderInterface;
  }
): Promise<Session[]> {
  const orderBy: Array<{ field: string; direction: "asc" | "desc" }> = [
    { field: "lastActivityAt", direction: "desc" },
    { field: "createdAt", direction: "desc" },
  ];

  const sessions = await deps.sessionDB.listSessions({
    taskId: params.task,
    limit: params.limit ?? 20,
    offset: params.offset ?? 0,
    createdAfter: params.since,
    createdBefore: params.until,
    orderBy,
    projectScope: params.projectScope,
  });

  return sessions.map((s) => ({ ...s, liveness: deriveSessionLiveness(s) })) as Session[];
}

/**
 * Structured result returned by deleteSessionImpl.
 */
export interface DeleteSessionResult {
  deleted: boolean;
  error?: string;
}

/**
 * Deletes a session based on parameters
 * Using proper dependency injection for better testability
 *
 * Returns a structured result so callers can surface error messages.
 * Also removes the session's workspace directory from the filesystem and
 * deletes the remote git branch if one exists.
 */
export async function deleteSessionImpl(
  params: SessionDeleteParams,
  deps: {
    sessionDB: SessionProviderInterface;
    gitService?: GitServiceInterface;
    fs?: { existsSync: typeof existsSync; rmSync: typeof rmSync };
    /** mt#3021 SC2: best-effort audit-event sink for a used override. */
    persistenceProvider?: PersistenceProvider;
  }
): Promise<DeleteSessionResult> {
  const { sessionId, task, repo } = params;
  const fsOps = deps.fs ?? { existsSync, rmSync };

  // Delete is destructive — require explicit identification, never auto-detect
  if (!sessionId && !task && !repo) {
    return {
      deleted: false,
      error: "Session delete requires a session name (--sessionId) or task ID (--task)",
    };
  }

  let resolvedSessionId: string;

  try {
    const resolvedContext = await resolveSessionContextWithFeedback({
      sessionId,
      task: task,
      repo: repo,
      sessionProvider: deps.sessionDB,
      allowAutoDetection: false,
    });
    resolvedSessionId = resolvedContext.sessionId;
  } catch (error) {
    // Non-existent session is not an error for delete — return structured false
    if (error instanceof ResourceNotFoundError) {
      const msg = `Session not found: ${sessionId || task || repo}`;
      log.debug(msg);
      return { deleted: false, error: msg };
    }
    if (error instanceof ValidationError) {
      const msg = `No session context resolved for deletion: ${sessionId || task || repo}`;
      log.debug(msg);
      return { deleted: false, error: msg };
    }
    throw error;
  }

  // Retrieve the session record so we can determine the branch name
  const sessionRecord = await deps.sessionDB.getSession(resolvedSessionId);

  // Compute the workspace dir once — used for both remote branch deletion and directory removal
  const sessionWorkspaceDir = `${getSessionsDir()}/${resolvedSessionId}`;

  // mt#3021 SC2: MERGE_HEAD/uncommitted-changes guard — runs INSIDE this
  // function (not only at the `session cleanup` command layer, which is the
  // ONLY existing safety check and which this incident's actual deletion
  // path bypassed entirely by calling deleteSessionImpl directly). Gates
  // BOTH the remote-branch deletion below AND the local rmSync — unconditional
  // with respect to any caller-supplied `force`: an agent that has already
  // reasoned itself into "safe to force" is exactly the failure mode this
  // guard exists to stop (see the mt#3021 spec's design decision). Only the
  // shared destructive-override contract lifts it.
  //
  // Terminal-state bypass (mt#3021 R1, pulled forward from mt#3104's
  // Layer-2 scope — see that task's spec for the note): a session whose OWN
  // status is already MERGED or CLOSED does not need this check at all —
  // its owning agent's work is definitionally finished, so there is no
  // in-flight work left to protect. Without this, `applyPostMergeStateSync`
  // (session-merge-status-sync.ts, called on every merge with `force: true`
  // and no override reason) would hit the guard on routine post-merge
  // cleanup whenever the workspace has ANY modified tracked file or
  // untracked non-ignored file (hasUncommittedChanges runs a bare `git
  // status --porcelain`, no `-uno`) — an under-deletion failure mode where
  // the workspace silently accumulates on disk forever, which is exactly
  // the "must not deadlock legitimate recovery" hazard the spec warns
  // about, just triggered by routine operation instead of a genuine
  // abandoned-session recovery. Mirrors the identical MERGED/CLOSED skip in
  // `identifyCleanupCandidates` (session-cleanup.ts) rather than inventing
  // a second convention.
  const isTerminalSession =
    sessionRecord?.status === SessionStatus.MERGED ||
    sessionRecord?.status === SessionStatus.CLOSED;
  if (!isTerminalSession) {
    const guardGitService = deps.gitService ?? (await (await import("../git")).createGitService());
    const gitState = await checkWorkspaceGitStateForDelete(
      guardGitService,
      sessionWorkspaceDir,
      fsOps
    );
    if (gitState.blocked) {
      const override = resolveDestructiveOverride(params.destructiveOverrideReason);
      if (!isValidDestructiveOverride(override)) {
        return {
          deleted: false,
          error:
            `${gitState.message} — refusing to delete session '${resolvedSessionId}' without ` +
            `an explicit destructiveOverrideReason.`,
        };
      }
      await recordDestructiveOverride({
        guard: "session-delete-git-state",
        reason: override.reason,
        details: { sessionId: resolvedSessionId, reasonCode: gitState.reasonCode },
        persistenceProvider: deps.persistenceProvider,
        relatedSessionId: resolvedSessionId,
        relatedTaskId: sessionRecord?.taskId,
      });
    }
  }

  // Delete the remote git branch if a git service is available
  if (deps.gitService && sessionRecord) {
    // Prefer the stored branch name (persisted since mt#782), fall back to
    // computing from taskId for sessions created before that change.
    const branchName =
      sessionRecord.branch ||
      (sessionRecord.taskId ? taskIdToBranchName(sessionRecord.taskId) : resolvedSessionId);

    if (fsOps.existsSync(sessionWorkspaceDir)) {
      try {
        log.debug(`Deleting remote branch '${branchName}' for session '${resolvedSessionId}'`);
        await deps.gitService.execInRepository(
          sessionWorkspaceDir,
          `push origin --delete ${branchName}`
        );
        log.debug(`Successfully deleted remote branch '${branchName}'`);
      } catch (error) {
        const msg = getErrorMessage(error);
        // Remote branch not existing is not an error — git exits with non-zero in that case.
        // Log at debug level; the deletion continues regardless.
        log.debug(
          `Remote branch '${branchName}' does not exist or could not be deleted (non-fatal): ${msg}`
        );
      }
    } else {
      log.debug(
        `Session workspace directory does not exist, skipping remote branch deletion: ${sessionWorkspaceDir}`
      );
    }
  }

  // Remove workspace directory from filesystem (if it exists)
  try {
    if (fsOps.existsSync(sessionWorkspaceDir)) {
      log.debug(`Removing session workspace directory: ${sessionWorkspaceDir}`);
      fsOps.rmSync(sessionWorkspaceDir, { recursive: true, force: true });
      log.debug(`Successfully removed session workspace directory: ${sessionWorkspaceDir}`);
    } else {
      log.debug(`Session workspace directory does not exist, skipping: ${sessionWorkspaceDir}`);
    }
  } catch (error) {
    // Filesystem removal failed — do NOT delete the DB record, as that would
    // create an orphan directory with no tracking. Surface the error to the caller.
    const msg = `Failed to remove session workspace directory '${sessionWorkspaceDir}': ${getErrorMessage(error)}`;
    log.error(msg);
    return {
      deleted: false,
      error: `${msg}. DB record preserved to prevent orphan directory.`,
    };
  }

  // Update status to CLOSED before deleting the record (best-effort)
  try {
    await deps.sessionDB.updateSession(resolvedSessionId, {
      lastActivityAt: new Date().toISOString(),
      status: SessionStatus.CLOSED,
    });
  } catch (e) {
    log.debug("Failed to update session status to CLOSED before deletion", { error: e });
  }

  // Delete the session record from the database
  const deleted = await deps.sessionDB.deleteSession(resolvedSessionId);
  return { deleted };
}

/**
 * Gets session directory based on parameters
 * Using proper dependency injection for better testability
 */
export async function getSessionDirImpl(
  params: SessionDirParams,
  deps: {
    sessionDB: SessionProviderInterface;
  }
): Promise<string> {
  let resolvedId: string;

  if (params.task && !params.sessionId) {
    // Find session by task ID
    const validatedTaskId = TaskIdSchema.parse(params.task);
    const session = await deps.sessionDB.getSessionByTaskId(validatedTaskId);

    if (!session) {
      throw new ResourceNotFoundError(`No session found for task ID "${validatedTaskId}"`);
    }

    resolvedId = session.sessionId;
  } else if (params.sessionId) {
    resolvedId = params.sessionId;
  } else {
    throw new ResourceNotFoundError(`🚫 Session Directory: Missing Required Parameter

You must provide either a session ID or task ID to get the session directory.

📖 Usage Examples:

  # Get directory by session ID
  minsky session dir <session-id>

  # Get directory by task ID
  minsky session dir --task <task-id>
  minsky session dir -t <task-id>

💡 Tips:
  • List available sessions: minsky session list
  • Get session by task ID: minsky session get --task <task-id>
  • Check current session: minsky session inspect`);
  }

  const session = await deps.sessionDB.getSession(resolvedId);

  if (!session) {
    throw new ResourceNotFoundError(`Session "${resolvedId}" not found`);
  }

  return deps.sessionDB.getSessionWorkdir(resolvedId);
}

/**
 * Inspects current session based on workspace location
 */
export async function inspectSessionImpl(
  _params: { json?: boolean },
  deps: {
    sessionDB: SessionProviderInterface;
  }
): Promise<Session | null> {
  // Auto-detect the current session from the workspace
  const context = await getCurrentSessionContext(process.cwd(), {
    sessionDbOverride: deps.sessionDB,
  });

  if (!context?.sessionId) {
    throw new ResourceNotFoundError("No session detected for the current workspace");
  }

  const session = await deps.sessionDB.getSession(context.sessionId);

  return session as Session | null;
}

/**
 * Comprehensive session cleanup with filesystem directory removal
 * This function handles complete cleanup including session directory deletion
 */
export async function cleanupSessionImpl(
  params: {
    sessionId: string;
    taskId?: string;
    force?: boolean;
    dryRun?: boolean;
    /**
     * mt#3021 SC2: justification required to clean up a workspace with an
     * in-progress merge (MERGE_HEAD present) or uncommitted changes. This is
     * a SEPARATE, UNCONDITIONAL check from `force` above — `force` only
     * skips the pre-existing (largely vacuous) `validateSessionSafeForCleanup`
     * stub; it does NOT lift this guard. This is deliberate: the incident
     * this task closes was a caller (`applyPostMergeStateSync`) that already
     * passes `force: true` unconditionally on every post-merge cleanup — the
     * exact "already reasoned itself into safe, passes a bare flag without
     * pausing" failure mode the shared override contract exists to stop.
     * NAME IS A PLACEHOLDER, principal-reserved (see mt#3021 PR body).
     */
    destructiveOverrideReason?: string;
  },
  deps: {
    sessionDB: SessionProviderInterface;
    gitService?: GitServiceInterface;
    /** mt#3021 SC2: best-effort audit-event sink for a used override. */
    persistenceProvider?: PersistenceProvider;
  }
): Promise<{
  sessionDeleted: boolean;
  directoriesRemoved: string[];
  errors: string[];
}> {
  const { sessionId, taskId, force = false, dryRun = false } = params;
  const directoriesRemoved: string[] = [];
  const errors: string[] = [];

  log.debug("Starting session cleanup", { sessionId, taskId, force, dryRun });

  try {
    // 1. Get session record before deletion
    const sessionRecord = await deps.sessionDB.getSession(sessionId);
    if (!sessionRecord) {
      log.debug(`Session ${sessionId} not found in database, skipping database cleanup`);
    }

    // 2. Determine session directories to clean up
    const sessionDirectories = await getSessionDirectoriesToCleanup(sessionId, taskId);

    if (dryRun) {
      log.debug("Dry run mode: would remove directories", { directories: sessionDirectories });
      return {
        sessionDeleted: false,
        directoriesRemoved: sessionDirectories,
        errors: [],
      };
    }

    // mt#3021 SC2: MERGE_HEAD/uncommitted-changes guard — unconditional with
    // respect to `force` (see the params doc comment above). Checks every
    // directory this call would remove; if any is blocked, refuse the whole
    // cleanup (fail closed) rather than partially clean up.
    //
    // Terminal-state bypass (mt#3021 R1, pulled forward from mt#3104's
    // Layer-2 scope): a session whose OWN status is already MERGED or
    // CLOSED skips this check entirely — its owning agent's work is
    // definitionally finished. Without this, `applyPostMergeStateSync`
    // (which calls this function with `force: true` and no override reason
    // on EVERY merge) would refuse routine post-merge cleanup whenever the
    // workspace has any modified tracked file or untracked non-ignored
    // file — a silent under-deletion regression (workspace dirs
    // accumulating on disk forever) that is the opposite failure mode from
    // the incident this guard exists to prevent. Mirrors the identical
    // MERGED/CLOSED skip in `identifyCleanupCandidates`
    // (session-cleanup.ts) rather than inventing a second convention.
    const isTerminalSession =
      sessionRecord?.status === SessionStatus.MERGED ||
      sessionRecord?.status === SessionStatus.CLOSED;
    if (!isTerminalSession) {
      const guardGitService =
        deps.gitService ?? (await (await import("../git")).createGitService());
      for (const directory of sessionDirectories) {
        const gitState = await checkWorkspaceGitStateForDelete(guardGitService, directory);
        if (gitState.blocked) {
          const override = resolveDestructiveOverride(params.destructiveOverrideReason);
          if (!isValidDestructiveOverride(override)) {
            const msg =
              `${gitState.message} — refusing to clean up session '${sessionId}' without ` +
              `an explicit destructiveOverrideReason.`;
            log.warn(msg);
            return {
              sessionDeleted: false,
              directoriesRemoved: [],
              errors: [msg],
            };
          }
          await recordDestructiveOverride({
            guard: "session-cleanup-git-state",
            reason: override.reason,
            details: { sessionId, taskId, reasonCode: gitState.reasonCode, directory },
            persistenceProvider: deps.persistenceProvider,
            relatedSessionId: sessionId,
            relatedTaskId: taskId,
          });
        }
      }
    }

    // 3. Safety validation (unless force flag is used)
    if (!force) {
      await validateSessionSafeForCleanup(sessionRecord as Session | null, sessionId, taskId);
    }

    // 4. Remove session directories
    for (const directory of sessionDirectories) {
      try {
        if (existsSync(directory)) {
          log.debug(`Removing session directory: ${directory}`);
          rmSync(directory, { recursive: true, force: true });
          directoriesRemoved.push(directory);
          log.debug(`Successfully removed directory: ${directory}`);
        } else {
          log.debug(`Directory does not exist, skipping: ${directory}`);
        }
      } catch (error) {
        const errorMsg = `Failed to remove directory ${directory}: ${getErrorMessage(error)}`;
        log.error(errorMsg, { directory, error });
        errors.push(errorMsg);
      }
    }

    // 5. Remove session from database — only if all directory removals succeeded.
    // If any directory removal failed, preserving the DB record prevents orphan directories.
    let sessionDeleted = false;
    if (sessionRecord && errors.length === 0) {
      try {
        sessionDeleted = await deps.sessionDB.deleteSession(sessionId);
        if (sessionDeleted) {
          log.debug(`Successfully removed session record: ${sessionId}`);
        } else {
          log.warn(`Failed to remove session record: ${sessionId}`);
        }
      } catch (error) {
        const errorMsg = `Failed to remove session from database: ${getErrorMessage(error)}`;
        log.error(errorMsg, { sessionId, error });
        errors.push(errorMsg);
      }
    } else if (errors.length > 0) {
      log.warn(
        `Skipping DB record deletion for session ${sessionId} — filesystem cleanup had errors. DB record preserved to prevent orphan directories.`
      );
    }

    log.debug("Session cleanup completed", {
      sessionId,
      sessionDeleted,
      directoriesRemoved: directoriesRemoved.length,
      errors: errors.length,
    });

    return {
      sessionDeleted,
      directoriesRemoved,
      errors,
    };
  } catch (error) {
    const errorMsg = `Session cleanup failed: ${getErrorMessage(error)}`;
    log.error(errorMsg, { sessionId, error });
    throw new ValidationError(errorMsg);
  }
}

/**
 * Get all session directories that should be cleaned up
 */
async function getSessionDirectoriesToCleanup(
  sessionId: string,
  taskId?: string
): Promise<string[]> {
  const directories: string[] = [];

  // Use getSessionsDir() to respect XDG_STATE_HOME
  const baseSessionPath = getSessionsDir();

  // Try different naming patterns that might exist.
  // The sessionId entry handles UUID session IDs directly.
  // Legacy patterns use the taskId to find old-style directories.
  const possibleDirs = [
    `${baseSessionPath}/${sessionId}`,
    taskId ? `${baseSessionPath}/task-${taskId}` : null,
    taskId ? `${baseSessionPath}/task#${taskId}` : null,
  ].filter(Boolean) as string[];

  // Deduplicate
  const uniqueDirs = [...new Set(possibleDirs)];

  for (const dir of uniqueDirs) {
    if (existsSync(dir)) {
      directories.push(dir);
    }
  }

  log.debug("Found session directories for cleanup", { sessionId, taskId, directories });
  return directories;
}

/**
 * Validate that a session is safe to clean up
 */
async function validateSessionSafeForCleanup(
  sessionRecord: Session | null,
  sessionId: string,
  taskId?: string
): Promise<void> {
  // For now, we'll implement basic validation
  // Future enhancements could include:
  // - Check if task is DONE
  // - Check if PR is merged
  // - Check for uncommitted changes

  if (!sessionRecord) {
    log.debug(`Session ${sessionId} not found in database, allowing cleanup`);
    return;
  }

  // Add more validation rules here in the future
  log.debug("Session validation passed for cleanup", { sessionId, taskId });
}

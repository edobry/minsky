import { ResourceNotFoundError, ValidationError } from "../../errors/index";
import { taskIdSchema as TaskIdSchema } from "../../schemas/common";
import type {
  SessionGetParams,
  SessionListParams,
  SessionDeleteParams,
  SessionDirParams,
} from "../../schemas/session";
import { resolveSessionContextWithFeedback } from "./session-context-resolver";
import { getCurrentSessionContext } from "../workspace";
import type { SessionProviderInterface, Session } from "./";
import { deriveSessionLiveness, SessionStatus } from "./types";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors";
import { rmSync, existsSync } from "node:fs";
import { getSessionsDir } from "../../utils/paths";
import type { GitServiceInterface } from "../git/types";
import { taskIdToBranchName } from "../tasks/task-id";

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

    resolvedId = session.session;
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
  },
  deps: {
    sessionDB: SessionProviderInterface;
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

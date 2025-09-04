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
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors";
import { rmSync, existsSync } from "node:fs";

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
  const { name, task, repo } = params;

  try {
    // Use unified session context resolver with auto-detection support
    const resolvedContext = await resolveSessionContextWithFeedback({
      session: name,
      task: task,
      repo: repo,
      sessionProvider: deps.sessionDB,
      allowAutoDetection: true,
    });

    // Get the session details using the resolved session name
    return deps.sessionDB.getSession(resolvedContext.sessionName);
  } catch (error) {
    // If error is about missing session requirements, provide better user guidance
    if (error instanceof ValidationError) {
      throw new ResourceNotFoundError(
        "No session detected. Please provide a session name (--name), task ID (--task), or run this command from within a session workspace."
      );
    }
    throw error;
  }
}

/**
 * Lists all sessions based on parameters
 * Using proper dependency injection for better testability
 */
export async function listSessionsImpl(
  _params: SessionListParams,
  deps: {
    sessionDB: SessionProviderInterface;
  }
): Promise<Session[]> {
  return deps.sessionDB.listSessions();
}

/**
 * Deletes a session based on parameters
 * Using proper dependency injection for better testability
 */
export async function deleteSessionImpl(
  params: SessionDeleteParams,
  deps: {
    sessionDB: SessionProviderInterface;
  }
): Promise<boolean> {
  const { name, task, repo } = params;

  try {
    // Use unified session context resolver with auto-detection support
    const resolvedContext = await resolveSessionContextWithFeedback({
      session: name,
      task: task,
      repo: repo,
      sessionProvider: deps.sessionDB,
      allowAutoDetection: true,
    });

    // Delete the session using the resolved session name
    return deps.sessionDB.deleteSession(resolvedContext.sessionName);
  } catch (error) {
    // If error is about missing session requirements, provide better user guidance
    if (error instanceof ValidationError) {
      throw new ResourceNotFoundError(
        "No session detected. Please provide a session name (--name), task ID (--task), or run this command from within a session workspace."
      );
    }
    throw error;
  }
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
  let sessionName: string;

  if (params.task && !params.name) {
    // Find session by task ID
    const validatedTaskId = TaskIdSchema.parse(params.task);
    const session = await deps.sessionDB.getSessionByTaskId(validatedTaskId);

    if (!session) {
      throw new ResourceNotFoundError(`No session found for task ID "${validatedTaskId}"`);
    }

    sessionName = session.session;
  } else if (params.name) {
    sessionName = params.name;
  } else {
    throw new ResourceNotFoundError(`🚫 Session Directory: Missing Required Parameter

You must provide either a session name or task ID to get the session directory.

📖 Usage Examples:

  # Get directory by session name
  minsky session dir <session-name>

  # Get directory by task ID
  minsky session dir --task <task-id>
  minsky session dir -t <task-id>

💡 Tips:
  • List available sessions: minsky session list
  • Get session by task ID: minsky session get --task <task-id>
  • Check current session: minsky session inspect`);
  }

  const session = await deps.sessionDB.getSession(sessionName);

  if (!session) {
    throw new ResourceNotFoundError(`Session "${sessionName}" not found`);
  }

  // Get repo path from session using the getRepoPath method which has fallback logic
  const repoPath = await deps.sessionDB.getRepoPath(session);

  return repoPath;
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
  const context = await getCurrentSessionContext(process.cwd());

  if (!context?.sessionId) {
    throw new ResourceNotFoundError("No session detected for the current workspace");
  }

  const session = await deps.sessionDB.getSession(context.sessionId);

  return session;
}

/**
 * Comprehensive session cleanup with filesystem directory removal
 * This function handles complete cleanup including session directory deletion
 */
export async function cleanupSessionImpl(
  params: {
    sessionName: string;
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
  const { sessionName, taskId, force = false, dryRun = false } = params;
  const directoriesRemoved: string[] = [];
  const errors: string[] = [];

  log.debug("Starting session cleanup", { sessionName, taskId, force, dryRun });

  try {
    // 1. Get session record before deletion
    const sessionRecord = await deps.sessionDB.getSession(sessionName);
    if (!sessionRecord) {
      log.debug(`Session ${sessionName} not found in database, skipping database cleanup`);
    }

    // 2. Determine session directories to clean up
    const sessionDirectories = await getSessionDirectoriesToCleanup(sessionName, taskId);

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
      await validateSessionSafeForCleanup(sessionRecord, sessionName, taskId);
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

    // 5. Remove session from database
    let sessionDeleted = false;
    if (sessionRecord) {
      try {
        sessionDeleted = await deps.sessionDB.deleteSession(sessionName);
        if (sessionDeleted) {
          log.debug(`Successfully removed session record: ${sessionName}`);
        } else {
          log.warn(`Failed to remove session record: ${sessionName}`);
        }
      } catch (error) {
        const errorMsg = `Failed to remove session from database: ${getErrorMessage(error)}`;
        log.error(errorMsg, { sessionName, error });
        errors.push(errorMsg);
      }
    }

    log.debug("Session cleanup completed", {
      sessionName,
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
    log.error(errorMsg, { sessionName, error });
    throw new ValidationError(errorMsg);
  }
}

/**
 * Get all session directories that should be cleaned up
 */
async function getSessionDirectoriesToCleanup(
  sessionName: string,
  taskId?: string
): Promise<string[]> {
  const directories: string[] = [];

  // Standard session directory patterns
  const baseSessionPath = `${process.env.HOME}/.local/state/minsky/sessions`;

  // Try different naming patterns that might exist
  const possibleDirs = [
    `${baseSessionPath}/${sessionName}`,
    taskId ? `${baseSessionPath}/task-${taskId}` : null,
    taskId ? `${baseSessionPath}/task#${taskId}` : null,
    taskId ? `${baseSessionPath}/task-md#${taskId}` : null,
  ].filter(Boolean) as string[];

  for (const dir of possibleDirs) {
    if (existsSync(dir)) {
      directories.push(dir);
    }
  }

  log.debug("Found session directories for cleanup", { sessionName, taskId, directories });
  return directories;
}

/**
 * Validate that a session is safe to clean up
 */
async function validateSessionSafeForCleanup(
  sessionRecord: Session | null,
  sessionName: string,
  taskId?: string
): Promise<void> {
  // For now, we'll implement basic validation
  // Future enhancements could include:
  // - Check if task is DONE
  // - Check if PR is merged
  // - Check for uncommitted changes

  if (!sessionRecord) {
    log.debug(`Session ${sessionName} not found in database, allowing cleanup`);
    return;
  }

  // Add more validation rules here in the future
  log.debug("Session validation passed for cleanup", { sessionName, taskId });
}

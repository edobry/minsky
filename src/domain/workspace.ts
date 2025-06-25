import { promises as fs } from "fs";
import { join } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { SessionDB } from "./session";
import { log } from "../utils/logger";

const execAsync = promisify(exec);

/**
 * Options for resolving a workspace path
 */
export interface WorkspaceResolutionOptions {
  /** Explicit filesystem path to a workspace */
  workspace?: string;
  /** Path to a session workspace */
  sessionWorkspace?: string;
  /** Path to a session repository (deprecated, use sessionWorkspace instead) */
  sessionRepo?: string;
}

// For dependency injection in tests
export interface TestDependencies {
  execAsync?: typeof execAsync;
  access?: typeof fs.access;
  getSessionFromRepo?: typeof getSessionFromWorkspace;
}

/**
 * Detects if the current directory is inside a session workspace
 * @param workspacePath The path to check
 * @returns true if in a session workspace, false otherwise
 */
export async function isSessionWorkspace(
  __workspacePath: string,
  execAsyncFn: typeof execAsync = execAsync
): Promise<boolean> {
  try {
    // Get the git root of the provided path
    const { stdout } = await execAsyncFn("git rev-parse --show-toplevel", { cwd: _workspacePath });
    const gitRoot = stdout.trim();

    // Check if the git root contains a session marker
    const xdgStateHome = process.env.XDGSTATE_HOME || join(process.env.HOME || "", ".local/state");
    const minskyPath = join(_xdgStateHome, "minsky", "git");

    if (gitRoot.startsWith(minskyPath)) {
      // Extract the relative path from the minsky git directory
      const relativePath = gitRoot.substring(minskyPath.length + 1);
      const pathParts = relativePath.split("/");

      // Should have at least 2 parts for legacy format (repoName/session)
      // or 3 parts for new format (repoName/sessions/session)
      return (
        pathParts.length >= 2 &&
        (pathParts.length === 2 ||
          (pathParts.length >= 3 && pathParts[1] === "sessions") ||
          // Check if any part of the path is a "sessions" directory
          // This handles nested directory structures like local/minsky/sessions/task#027
          pathParts.some(
            (part, index) => index > 0 && index < pathParts.length - 1 && part === "sessions"
          ))
      );
    }

    return false;
  } catch (_error) {
    return false;
  }
}

// Create alias for backward compatibility
export const isSessionRepository = isSessionWorkspace;

/**
 * Get session information from a workspace path
 * @param workspacePath The path to check
 * @returns Information about the session if found, null otherwise
 */
export async function getSessionFromWorkspace(
  __workspacePath: string,
  execAsyncFn: typeof execAsync = execAsync,
  sessionDbOverride?: { getSession: SessionDB["getSession"] }
): Promise<{
  session: string;
  upstreamRepository: string;
} | null> {
  try {
    // Get the git root of the provided path
    const { stdout } = await execAsyncFn("git rev-parse --show-toplevel", { cwd: _workspacePath });
    const gitRoot = stdout.trim();

    // Check if this is in the minsky sessions directory structure
    const xdgStateHome = process.env.XDGSTATE_HOME || join(process.env.HOME || "", ".local/state");
    const minskyPath = join(_xdgStateHome, "minsky", "git");

    if (!gitRoot.startsWith(minskyPath)) {
      return null;
    }

    // Extract session name from the path
    // Pattern could be either:
    // - Legacy: <minsky_path>/<repo_name>/<session_name>
    // - New: <minsky_path>/<repo_name>/sessions/<session_name>
    const relativePath = gitRoot.substring(minskyPath.length + 1);
    const pathParts = relativePath.split("/");

    if (pathParts.length < 2) {
      return null;
    }

    // Get the session name from the path parts
    let _sessionName;
    if (pathParts.length >= 3 && pathParts[1] === "sessions") {
      // New path format: <repo_name>/sessions/<session_name>
      sessionName = pathParts[2];
    } else if (pathParts.length === 2) {
      // Legacy path format: <repo_name>/<session_name>
      sessionName = pathParts[1];
    } else {
      // Look for a "sessions" directory in the path
      for (let i = 1; i < pathParts.length - 1; i++) {
        if (pathParts[i] === "sessions") {
          // The session name is the directory after "sessions"
          sessionName = pathParts[i + 1];
          break;
        }
      }
    }

    // Type check to ensure sessionName is a string (for the compiler)
    if (typeof sessionName !== "string") {
      return null;
    }

    const db = sessionDbOverride || new SessionDB();
    const sessionRecord = await db.getSession(_sessionName);

    if (!sessionRecord || !sessionRecord.repoUrl) {
      return null;
    }

    return {
      session: sessionName,
      upstreamRepository: sessionRecord.repoUrl,
    };
  } catch (_error) {
    return null;
  }
}

// Alias getSessionFromWorkspace as getSessionFromRepo for backwards compatibility
export const getSessionFromRepo = getSessionFromWorkspace;

/**
 * Resolve the workspace path for task operations
 * Modified to use the current working directory when in a session workspace
 * This ensures operations use the local rules directory in session workspaces
 *
 * Resolution strategy:
 * 1. Use explicitly provided workspace path if available
 * 2. Use session repo path if provided (for backward compatibility)
 * 3. Use current directory as workspace
 */
export async function resolveWorkspacePath(
  _options?: WorkspaceResolutionOptions,
  deps: TestDependencies = {}
): Promise<string> {
  const { access = fs.access } = deps;

  // If workspace path is explicitly provided, use it
  if (_options?.workspace) {
    // Validate if it"s a valid workspace
    try {
      const processDir = join(_options.workspace, "process");
      await access(processDir);
      return _options.workspace;
    } catch (_error) {
      throw new Error(
        `Invalid workspace path: ${_options.workspace}. Path must be a valid Minsky workspace.`
      );
    }
  }

  // For backward compatibility, use sessionRepo if provided
  if (_options?.sessionRepo) {
    return _options.sessionRepo;
  }

  // Use current directory or provided session workspace as workspace
  const checkPath = _options?.sessionWorkspace || process.cwd();

  // Note: We"re no longer redirecting to the upstream repository path when in a session
  // This allows rules commands to operate on the current directory's rules
  return checkPath;
}

/**
 * Returns the current session name if in a session workspace, or null otherwise.
 * Uses getSessionFromWorkspace to extract the session context from the current working directory.
 */
export async function getCurrentSession(
  _cwd: string = process.cwd(),
  execAsyncFn: typeof execAsync = execAsync,
  sessionDbOverride?: { getSession: SessionDB["getSession"] }
): Promise<string | null> {
  const sessionInfo = await getSessionFromWorkspace(_cwd, execAsyncFn, sessionDbOverride);
  return sessionInfo ? sessionInfo.session : null;
}

/**
 * Returns the current session ID and associated task ID if in a session workspace, or null otherwise.
 * Uses getSessionFromWorkspace to extract the session context from the current working directory
 * and then queries the SessionDB for the taskId.
 */
export async function getCurrentSessionContext(
  _cwd: string = process.cwd(),
  // Added getCurrentSessionFn dependency for better testability
  dependencies: {
    execAsyncFn?: typeof execAsync;
    sessionDbOverride?: { getSession: SessionDB["getSession"] };
    getCurrentSessionFn?: typeof getCurrentSession;
  } = {}
): Promise<{ sessionId: string; taskId?: string } | null> {
  const {
    execAsyncFn = execAsync,
    sessionDbOverride,
    getCurrentSessionFn = getCurrentSession, // Default to actual implementation
  } = dependencies;

  const currentSessionName = await getCurrentSessionFn(_cwd, execAsyncFn, sessionDbOverride);

  if (!currentSessionName) {
    return null;
  }

  const db = sessionDbOverride
    ? ({ getSession: sessionDbOverride.getSession } as SessionDB)
    : new SessionDB();

  try {
    const sessionRecord = await db.getSession(currentSessionName);
    if (!sessionRecord) {
      log.warn("Session record not found in database", {
        _sessionName: currentSessionName,
        cwd,
      });
      return null;
    }
    return {
      sessionId: currentSessionName,
      taskId: sessionRecord.taskId,
    };
  } catch (error) {
    log.error("Error fetching session record", {
      _sessionName: currentSessionName,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      cwd,
    });
    return null;
  }
}

/**
 * Interface for workspace utility operations
 * This defines the contract for workspace-related functionality
 */
export interface WorkspaceUtilsInterface {
  /**
   * Check if the current directory is a Minsky workspace
   */
  isWorkspace(path: string): Promise<boolean>;

  /**
   * Check if the current directory is a session workspace
   */
  isSessionWorkspace(path: string): Promise<boolean>;

  /**
   * Get the current session name if in a session workspace
   */
  getCurrentSession(__repoPath: string): Promise<string | null>;

  /**
   * Get the session name from a workspace path
   */
  getSessionFromWorkspace(__workspacePath: string): Promise<string | null>;

  /**
   * Resolve a workspace path from inputs
   */
  resolveWorkspacePath(__options: { workspace?: string; sessionRepo?: string }): Promise<string>;
}

/**
 * Creates a WorkspaceUtils implementation
 * This factory function provides a consistent way to get workspace utilities with optional customization
 *
 * @returns A WorkspaceUtilsInterface implementation
 */
export function createWorkspaceUtils(): WorkspaceUtilsInterface {
  return {
    isWorkspace: async (path: string): Promise<boolean> => {
      try {
        // A workspace is valid if it contains a process directory
        const processDir = join(_path, "process");
        await fs.access(processDir);
        return true;
      } catch (_error) {
        return false;
      }
    },

    isSessionWorkspace,

    getCurrentSession: async (_repoPath: string): Promise<string | null> => {
      return getCurrentSession(_repoPath);
    },

    getSessionFromWorkspace: async (workspacePath: string): Promise<string | null> => {
      const result = await getSessionFromWorkspace(workspacePath);
      return result ? result.session : null;
    },

    resolveWorkspacePath: async (_options: {
      workspace?: string;
      sessionRepo?: string;
    }): Promise<string> => {
      return resolveWorkspacePath(_options);
    },
  };
}

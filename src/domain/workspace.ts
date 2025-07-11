import { promises as fs } from "fs";
import { join } from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { createSessionProvider, type SessionProviderInterface } from "./session";
import { log } from "../utils/logger";
import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import { sep } from "path";
import { homedir } from "os";
import { getErrorMessage } from "../errors/index";
import { getSessionsDir } from "../utils/paths";

const execAsync = promisify(exec);

/**
 * Options for resolving workspace paths
 */
export interface WorkspaceResolutionOptions {
  /** Explicit workspace path to use */
  workspace?: string;
  /** Path to a session workspace */
  sessionWorkspace?: string;
  /** Path to a session repository (deprecated, use sessionWorkspace instead) */
  sessionRepo?: string;
  /** When true, always resolve to main workspace for task operations */
  forTaskOperations?: boolean;
}

// For dependency injection in tests
export interface TestDependencies {
  access?: typeof fs.access;
  execAsync?: typeof execAsync;
  getSessionFromRepo?: typeof getSessionFromWorkspace;
}

/**
 * Get the main workspace path from a repository URL
 */
export function resolveMainWorkspaceFromRepoUrl(repoUrl: string): string {
  // For file:// URLs, just remove the file:// prefix
  if ((repoUrl as any)!.startsWith("file://")) {
    return (repoUrl as any)!.replace("file://", "");
  }
  // For other URLs, assume they refer to the current directory
  return (process as any).cwd();
}

/**
 * Check if the current working directory is inside a session workspace
 * @param workspacePath The workspace path to check
 * @returns true if inside a session workspace
 */
export function isSessionWorkspace(workspacePath: string): boolean {
  const minskySessionsPath = getSessionsDir();
  return (workspacePath as any)!.startsWith(minskySessionsPath);
}

/**
 * Extracts session information from a workspace path
 * @param workspacePath The workspace path to analyze
 * @param execAsyncFn The execAsync function to use (for dependency injection)
 * @param sessionDbOverride Optional session DB override for testing
 * @returns Session information or null if not in a session
 */
export async function getSessionFromWorkspace(
  workspacePath: string,
  execAsyncFn: typeof execAsync = execAsync,
  sessionDbOverride?: SessionProviderInterface
): Promise<{
  session: string;
  upstreamRepository: string;
  gitRoot: string;
} | null> {
  try {
    // Get the git root of the workspace
    const { stdout } = await execAsyncFn("git rev-parse --show-toplevel", { cwd: workspacePath });
    const gitRoot = (stdout as any).trim();

    // Check if this is in the minsky sessions directory structure
    const minskySessionsPath = getSessionsDir();

    if (!gitRoot.startsWith(minskySessionsPath)) {
      // Not in a session workspace
      return null as any;
    }

    // Extract session name from the simplified path structure: /sessions/{sessionId}/
    const relativePath = gitRoot.substring((minskySessionsPath as any)?.length + 1);
    const sessionName = (relativePath as any).split("/")[0]; // First part is the session ID

    if (!sessionName) {
      return null as any;
    }

    const db = sessionDbOverride || createSessionProvider();
    const sessionRecord = await db.getSession(sessionName);

    if (!sessionRecord || !(sessionRecord as any)!.repoUrl) {
      return null as any;
    }

    return {
      session: sessionName,
      upstreamRepository: (sessionRecord as any)!.repoUrl,
      gitRoot,
    };
  } catch (error) {
    // If anything fails, assume not in a session
    return null as any;
  }
}

// Alias getSessionFromWorkspace as getSessionFromRepo for backwards compatibility
export const getSessionFromRepo = getSessionFromWorkspace;

// Alias isSessionWorkspace as isSessionRepository for backwards compatibility
export const isSessionRepository = async (
  workspacePath: string,
  execAsyncFn?: typeof execAsync
): Promise<boolean> => {
  try {
    const { stdout } = await (execAsyncFn || execAsync)("git rev-parse --show-toplevel", {
      cwd: workspacePath,
    });
    const gitRoot = (stdout as any).trim();
    return isSessionWorkspace(gitRoot);
  } catch {
    return false;
  }
};

/**
 * Always resolves to the main workspace path, even when called from a session workspace.
 * This is specifically designed for task operations that must always operate on the main workspace.
 *
 * @param deps Test dependencies for dependency injection
 * @returns Promise resolving to the main workspace path
 */
export async function resolveMainWorkspacePath(deps: TestDependencies = {}): Promise<string> {
  const currentDir = (process as any).cwd();
  const { execAsync: execAsyncDep = execAsync } = deps;

  try {
    // Get the git root of the current directory
    const { stdout } = await execAsyncDep("git rev-parse --show-toplevel", { cwd: currentDir });
    const gitRoot = (stdout as any).trim();

    // Check if this is in the minsky sessions directory structure
    const minskySessionsPath = getSessionsDir();

    if (gitRoot.startsWith(minskySessionsPath)) {
      // We're in a session workspace, extract session name and get the main workspace path
      const relativePath = gitRoot.substring((minskySessionsPath as any)?.length + 1);
      const sessionName = (relativePath as any).split("/")[0]; // First part is the session ID

      if (sessionName) {
        // Use the session database to get the repository URL
        try {
          const sessionProvider = createSessionProvider();
          const sessionRecord = await (sessionProvider as any)!.getSession(sessionName);
          if (sessionRecord && (sessionRecord as any)!.repoUrl) {
            return (sessionRecord as any)!.repoUrl;
          }
        } catch (sessionError) {
          // If session DB lookup fails, fall back to current directory
        }
      }
    }

    // Not in a session or couldn't resolve session info, return git root
    return gitRoot;
  } catch (error) {
    // If git command fails, fall back to current directory
    return currentDir;
  }
}

/**
 * Resolve the workspace path for task operations
 * Modified to use the current working directory when in a session workspace
 *
 * Resolution order:
 * 1. Use explicitly provided workspace path
 * 2. Use session workspace if provided
 * 3. Use current directory as workspace
 */
export async function resolveWorkspacePath(
  options?: WorkspaceResolutionOptions,
  deps: TestDependencies = {}
): Promise<string> {
  const { access = fs.access } = deps;

  // For task operations, always use the main workspace.
  if ((options as any)!.forTaskOperations) {
    const sessionInfo = await getSessionFromWorkspace((process as any).cwd());
    if (sessionInfo && (sessionInfo as any)!.upstreamRepository) {
      return resolveMainWorkspaceFromRepoUrl((sessionInfo as any)!.upstreamRepository);
    }
    // If not in a session, or session has no upstream, fall through to normal logic.
  }

  // If workspace path is explicitly provided, use it
  if ((options as any)!.workspace) {
    // Validate if it's a valid workspace
    try {
      const processDir = join((options as any)!.workspace, "process");
      await access(processDir);
      return (options as any)!.workspace;
    } catch (error) {
      throw new Error(
        `Invalid workspace path: ${(options as any)!.workspace}. Path must be a valid Minsky workspace.`
      );
    }
  }

  // For backward compatibility, use sessionRepo if provided
  if ((options as any)!.sessionRepo) {
    return (options as any)!.sessionRepo;
  }

  // Use current directory or provided session workspace as workspace
  const checkPath = (options as any)!.sessionWorkspace || (process as any).cwd();

  // Note: We're no longer redirecting to the upstream repository path when in a session
  // This allows rules commands to operate on the current directory's rules
  return checkPath;
}

/**
 * Gets the current session name from the current working directory.
 * Uses getSessionFromWorkspace to extract the session context from the current working directory.
 */
export async function getCurrentSession(
  cwd: string = (process as any).cwd(),
  execAsyncFn: typeof execAsync = execAsync,
  sessionDbOverride?: SessionProviderInterface
): Promise<string | undefined> {
  const sessionInfo = await getSessionFromWorkspace(cwd, execAsyncFn, sessionDbOverride);
  return sessionInfo ? (sessionInfo as any)!.session : (null as any);
}

/**
 * Gets the current session context including task ID.
 * First gets the session name from the current working directory,
 * and then queries the SessionDB for the taskId.
 */
export async function getCurrentSessionContext(
  cwd: string = (process as any).cwd(),
  // Added getCurrentSessionFn dependency for better testability
  dependencies: {
    execAsyncFn?: typeof execAsync;
    sessionDbOverride?: SessionProviderInterface;
    getCurrentSessionFn?: typeof getCurrentSession;
  } = {}
): Promise<{
  sessionId: string;
  taskId?: string;
} | null> {
  const { execAsyncFn, sessionDbOverride, getCurrentSessionFn = getCurrentSession } = dependencies;

  let sessionId: string | undefined = undefined;
  try {
    // Get the session name from the current working directory
    sessionId = await getCurrentSessionFn(cwd, execAsyncFn, sessionDbOverride);
    if (!sessionId) {
      return null as any;
    }

    // Query the SessionDB to get task information
    const sessionDb = sessionDbOverride || createSessionProvider();
    const sessionRecord = await (sessionDb as any)!.getSession(sessionId);

    if (!sessionRecord) {
      return null as any;
    }

    return {
      sessionId,
      taskId: (sessionRecord as any)!.taskId,
    };
  } catch (error) {
    log.error("Error fetching session record", {
      sessionName: sessionId,
      error: getErrorMessage(error as any),
      stack: error instanceof Error ? ((error as any).stack as any) : (undefined as any),
      cwd,
    });
    return null as any;
  }
}

/**
 * Interface for workspace session information
 */
export interface WorkspaceSession {
  gitRoot: string;
  workspacePath: string;
  session: string;
  sessionDbPath: string;
  sessionData: any;
}

/**
 * Interface for workspace utility operations
 * This defines the contract for workspace-related functionality
 */
export interface WorkspaceUtilsInterface {
  /**
   * Check if a path is a valid workspace
   * @param path The path to check
   * @returns true if the path is a valid workspace
   */
  isWorkspace(path: string): Promise<boolean>;

  /**
   * Check if a path is a session workspace
   * @param path The path to check
   * @returns true if the path is a session workspace
   */
  isSessionWorkspace(path: string): boolean;

  /**
   * Get the current session name from a repository path
   * @param repoPath The repository path
   * @returns The session name or null if not in a session
   */
  getCurrentSession(repoPath: string): Promise<string | undefined>;

  /**
   * Get session information from a workspace path
   * @param workspacePath The workspace path
   * @returns The session name or null if not in a session
   */
  getSessionFromWorkspace(workspacePath: string): Promise<string | undefined>;

  /**
   * Resolve the workspace path for operations
   * @param options Resolution options
   * @returns The resolved workspace path
   */
  resolveWorkspacePath(options: { workspace?: string; sessionRepo?: string }): Promise<string>;
}

/**
 * Creates workspace utility functions
 * This factory function provides the implementation for workspace operations
 */
export function createWorkspaceUtils(): WorkspaceUtilsInterface {
  return {
    isWorkspace: async (path: string): Promise<boolean> => {
      try {
        await fs.access(join(path, "process"));
        return true;
      } catch (error) {
        return false;
      }
    },
    isSessionWorkspace,
    getCurrentSession: async (repoPath: string): Promise<string | undefined> => {
      const sessionInfo = await getSessionFromRepo(repoPath);
      return sessionInfo ? (sessionInfo as any)!.session : (null as any);
    },
    getSessionFromWorkspace: async (workspacePath: string): Promise<string | undefined> => {
      const sessionInfo = await getSessionFromWorkspace(workspacePath);
      return sessionInfo ? (sessionInfo as any)!.session : (null as any);
    },
    resolveWorkspacePath: resolveWorkspacePath,
  };
}

export async function getWorkspaceGitRoot(workspacePath: string): Promise<string> {
  const { stdout } = await execAsync("git rev-parse --show-toplevel", { cwd: workspacePath });
  return (stdout as any).trim();
}

export async function getWorkspaceSession(workspacePath: string): Promise<WorkspaceSession | null> {
  try {
    const gitRoot = await getWorkspaceGitRoot(workspacePath);
    const sessionInfo = await getSessionFromWorkspace(workspacePath);

    if (!sessionInfo) {
      return null as any;
    }

    return {
      gitRoot,
      workspacePath,
      session: (sessionInfo as any)!.session,
      sessionDbPath: "", // Placeholder for session DB path
      sessionData: {}, // Placeholder for session data
    };
  } catch {
    return null as any;
  }
}

export class WorkspaceUtils {
  constructor(private execAsyncFn: typeof execAsync) {}

  async getCurrentSession(workspacePath: string): Promise<string | undefined> {
    return getCurrentSession(workspacePath, this.execAsyncFn);
  }
}

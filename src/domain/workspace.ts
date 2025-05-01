import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { SessionDB } from './session';

const execAsync = promisify(exec);

export interface WorkspaceResolutionOptions {
  workspace?: string;
  sessionRepo?: string;
}

// For dependency injection in tests
export interface TestDependencies {
  execAsync?: typeof execAsync;
  access?: typeof fs.access;
  getSessionFromRepo?: typeof getSessionFromRepo;
}

/**
 * Detects if the current directory is inside a session repository
 * @returns true if in a session repo, false otherwise
 */
export async function isSessionRepository(
  repoPath: string, 
  execAsyncFn: typeof execAsync = execAsync
): Promise<boolean> {
  try {
    // Get the git root of the provided path
    const { stdout } = await execAsyncFn("git rev-parse --show-toplevel", { cwd: repoPath });
    const gitRoot = stdout.trim();
    
    // Check if the git root contains a session marker
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
    const minskyPath = join(xdgStateHome, "minsky", "git");
    
    if (gitRoot.startsWith(minskyPath)) {
      // Extract the relative path from the minsky git directory
      const relativePath = gitRoot.substring(minskyPath.length + 1);
      const pathParts = relativePath.split("/");
      
      // Check for the sessions directory in the path parts
      // This handles both legacy format (repoName/session)
      // and nested directories with a sessions folder
      if (pathParts.length >= 2) {
        // Legacy format: repoName/session
        if (pathParts.length === 2) {
          return true;
        }
        
        // Check if any part of the path is a "sessions" directory
        // This handles nested directory structures like local/minsky/sessions/task#027
        for (let i = 1; i < pathParts.length - 1; i++) {
          if (pathParts[i] === "sessions") {
            return true;
          }
        }
      }
    }
    
    return false;
  } catch (error) {
    return false;
  }
}

/**
 * Get session information from a repository path
 * @param repoPath The path to check
 * @returns Information about the session if found, null otherwise
 */
export async function getSessionFromRepo(
  repoPath: string, 
  execAsyncFn: typeof execAsync = execAsync,
  sessionDbOverride?: { getSession: SessionDB["getSession"] }
): Promise<{ 
  session: string;
  mainWorkspace: string;
  path: string;
} | null> {
  try {
    const isSession = await isSessionRepository(repoPath, execAsyncFn);
    if (!isSession) {
      return null;
    }

    // Get the git root of the provided path
    const { stdout } = await execAsyncFn("git rev-parse --show-toplevel", { cwd: repoPath });
    const gitRoot = stdout.trim();

    // Parse the path to extract the session name
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
    const minskyPath = join(xdgStateHome, "minsky", "git");
    const relativePath = gitRoot.substring(minskyPath.length + 1);
    const pathParts = relativePath.split("/");

    let sessionName: string | undefined;

    if (pathParts.length === 2) {
      // Legacy format: repoName/session
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

    if (!sessionName) {
      return null;
    }

    const db = sessionDbOverride || new SessionDB();
    const sessionRecord = await db.getSession(sessionName);
    
    if (!sessionRecord || !sessionRecord.repoUrl) {
      return null;
    }
    
    return {
      session: sessionName,
      mainWorkspace: sessionRecord.repoUrl,
      path: gitRoot
    };
  } catch (error) {
    return null;
  }
}

/**
 * Resolve the main workspace path for task operations
 * This ensures task operations are performed in the main workspace
 * even when executed from a session repository
 * 
 * Resolution strategy:
 * 1. Use explicitly provided workspace path if available
 * 2. If in a session repo, use the main workspace path
 * 3. Use current directory as workspace
 */
export async function resolveWorkspacePath(
  options?: WorkspaceResolutionOptions,
  deps: TestDependencies = {}
): Promise<string> {
  const {
    access = fs.access,
    getSessionFromRepo: getSessionFromRepoFn = getSessionFromRepo
  } = deps;

  // If workspace path is explicitly provided, use it
  if (options?.workspace) {
    // Validate if it's a valid workspace
    try {
      const processDir = join(options.workspace, 'process');
      await access(processDir);
      return options.workspace;
    } catch (error) {
      throw new Error(`Invalid workspace path: ${options.workspace}. Path must be a valid Minsky workspace.`);
    }
  }
  
  // Check if current or provided path is a session repository
  const checkPath = options?.sessionRepo || process.cwd();
  const sessionInfo = await getSessionFromRepoFn(checkPath);
  
  if (sessionInfo) {
    // Strip file:// protocol if present
    let mainWorkspace = sessionInfo.path;
    if (mainWorkspace.startsWith('file://')) {
      mainWorkspace = mainWorkspace.replace(/^file:\/\//, '');
    }
    return mainWorkspace;
  }
  
  // If not in a session repo, use current directory
  return checkPath;
}

/**
 * Get the current session name from the working directory
 * @returns The session name if in a session workspace, null otherwise
 */
export async function getCurrentSession(
  workingDir: string = process.cwd(),
  execAsyncFn: typeof execAsync = execAsync
): Promise<string | null> {
  try {
    const sessionInfo = await getSessionFromRepo(workingDir, execAsyncFn);
    
    if (sessionInfo) {
      return sessionInfo.session;
    }
    
    return null;
  } catch (error) {
    return null;
  }
} 

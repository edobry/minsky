import { promises as fs } from 'fs';
import { join, dirname, basename } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { SessionDB } from './session';

const execAsync = promisify(exec);

export interface WorkspaceResolutionOptions {
  workspace?: string;
  sessionRepo?: string;
}

/**
 * Detects if the current directory is inside a session repository
 * @returns true if in a session repo, false otherwise
 */
export async function isSessionRepository(repoPath: string): Promise<boolean> {
  try {
    // Get the git root of the provided path
    const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd: repoPath });
    const gitRoot = stdout.trim();
    
    // Check if the git root contains a session marker
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || '', '.local/state');
    const minskyPath = join(xdgStateHome, 'minsky', 'git');
    
    return gitRoot.startsWith(minskyPath);
  } catch (error) {
    return false;
  }
}

/**
 * Extracts a session name from a path, handling both legacy and new formats
 * Legacy format: <minsky_path>/<repo_name>/<session_name>
 * New format: <minsky_path>/<repo_name>/sessions/<session_name>
 * @param path Path from which to extract session name
 * @param minskyPath Base minsky sessions path
 * @returns Session name if in a valid format, null otherwise
 */
function extractSessionName(path: string, minskyPath: string): string | null {
  if (!path || !minskyPath || !path.startsWith(minskyPath)) {
    return null;
  }
  
  const relativePath = path.substring(minskyPath.length + 1);
  const pathParts = relativePath.split('/');
  
  // Ensure we have at least repo and session parts
  if (pathParts.length < 2) {
    return null;
  }
  
  // Check for the new format: <minsky_path>/<repo_org>/<repo_name>/sessions/<session_name>
  // or <minsky_path>/<repo_type>/<repo_name>/sessions/<session_name>
  if (pathParts.length >= 4 && pathParts[2] === 'sessions') {
    return pathParts[3] || null;
  }
  
  // Check for the new format with repo as a single directory: <minsky_path>/<repo_name>/sessions/<session_name>
  if (pathParts.length >= 3 && pathParts[1] === 'sessions') {
    return pathParts[2] || null;
  }
  
  // Legacy format with repo parts: <minsky_path>/<repo_org>/<repo_name>/<session_name>
  if (pathParts.length >= 3) {
    return pathParts[pathParts.length - 1] || null;
  }
  
  // Simple legacy format: <minsky_path>/<repo_name>/<session_name>
  return pathParts[1] || null;
}

/**
 * Get session information from a repository path
 * @param repoPath Path to the repository
 * @returns Session information if in a session repo, null otherwise
 */
export async function getSessionFromRepo(repoPath: string): Promise<{ 
  session: string, 
  mainWorkspace: string 
} | null> {
  try {
    // Get the git root of the provided path
    const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd: repoPath });
    const gitRoot = stdout.trim();
    
    // Check if this is in the minsky sessions directory structure
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || '', '.local/state');
    const minskyPath = join(xdgStateHome, 'minsky', 'git');
    
    if (!gitRoot.startsWith(minskyPath)) {
      return null;
    }
    
    // Extract session name from the path, handling both legacy and new formats
    const sessionName = extractSessionName(gitRoot, minskyPath);
    if (!sessionName) {
      return null;
    }
    
    const db = new SessionDB();
    const sessionRecord = await db.getSession(sessionName);
    
    if (!sessionRecord || !sessionRecord.repoUrl) {
      return null;
    }
    
    return {
      session: sessionName,
      mainWorkspace: sessionRecord.repoUrl
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
export async function resolveWorkspacePath(options?: WorkspaceResolutionOptions): Promise<string> {
  // If workspace path is explicitly provided, use it
  if (options?.workspace) {
    // Validate if it's a valid workspace
    try {
      const processDir = join(options.workspace, 'process');
      await fs.access(processDir);
      return options.workspace;
    } catch (error) {
      throw new Error(`Invalid workspace path: ${options.workspace}. Path must be a valid Minsky workspace.`);
    }
  }
  
  // Check if current or provided path is a session repository
  const checkPath = options?.sessionRepo || process.cwd();
  const sessionInfo = await getSessionFromRepo(checkPath);
  
  if (sessionInfo) {
    return sessionInfo.mainWorkspace;
  }
  
  // If not in a session repo, use current directory
  return checkPath;
} 

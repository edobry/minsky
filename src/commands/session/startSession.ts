import { GitService } from '../../domain/git';
import { SessionDB } from '../../domain/session';
import fsDefault from 'fs';
import pathDefault from 'path';
import { resolveRepoPath as resolveRepoPathDefault } from '../../domain/repo-utils';

export interface StartSessionOptions {
  session: string;
  repo?: string;
  taskId?: string;
  gitService?: any;
  sessionDB?: any;
  fs?: typeof fsDefault;
  path?: typeof pathDefault;
  resolveRepoPath?: typeof resolveRepoPathDefault;
}

export interface StartSessionResult {
  cloneResult: any;
  branchResult: any;
  sessionRecord: any;
}

export async function startSession({ session, repo, taskId, gitService, sessionDB, fs, path, resolveRepoPath }: StartSessionOptions): Promise<StartSessionResult> {
  gitService = gitService || new GitService();
  sessionDB = sessionDB || new SessionDB();
  fs = fs || fsDefault;
  path = path || pathDefault;
  resolveRepoPath = resolveRepoPath || resolveRepoPathDefault;

  // Check if session already exists
  const existingSession = await sessionDB.getSession(session);
  if (existingSession) {
    throw new Error(`Session '${session}' already exists`);
  }

  // Determine repo URL or path
  let repoUrl = repo;
  if (!repoUrl) {
    try {
      repoUrl = await resolveRepoPath({});
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      throw new Error(`--repo is required (not in a git repo and no --repo provided): ${error.message}`);
    }
  }

  // If local path, convert to file:// URL
  const isLocalPath = fs.existsSync(repoUrl) && fs.statSync(repoUrl).isDirectory();
  if (isLocalPath && !repoUrl.startsWith('file://')) {
    const absolutePath = path.resolve(repoUrl);
    repoUrl = `file://${absolutePath}`;
  }

  // Clone the repo
  const cloneResult = await gitService.clone({
    repoUrl,
    session
  });

  // Create a branch named after the session
  const branchResult = await gitService.branch({
    session,
    branch: session
  });

  // Record the session
  const sessionRecord = {
    session,
    repoUrl,
    branch: session,
    createdAt: new Date().toISOString(),
    ...(taskId ? { taskId } : {})
  };
  await sessionDB.addSession(sessionRecord);

  return { cloneResult, branchResult, sessionRecord };
} 

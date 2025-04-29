import { GitService } from '../../domain/git';
import { SessionDB } from '../../domain/session';
import type { SessionRecord } from '../../domain/session';
import { TaskService } from '../../domain/tasks';
import fsDefault from 'fs';
import pathDefault from 'path';
import { resolveRepoPath as resolveRepoPathDefault } from '../../domain/repo-utils';

export interface StartSessionOptions {
  session?: string;
  repo?: string;
  taskId?: string;
  gitService?: any;
  sessionDB?: any;
  fs?: typeof fsDefault;
  path?: typeof pathDefault;
  resolveRepoPath?: typeof resolveRepoPathDefault;
  taskService?: TaskService;
}

export interface StartSessionResult {
  cloneResult: any;
  branchResult: any;
  sessionRecord: any;
}

export async function startSession({ session, repo, taskId, gitService, sessionDB, fs, path, resolveRepoPath, taskService }: StartSessionOptions): Promise<StartSessionResult> {
  gitService = gitService || new GitService();
  sessionDB = sessionDB || new SessionDB();
  fs = fs || fsDefault;
  path = path || pathDefault;
  resolveRepoPath = resolveRepoPath || resolveRepoPathDefault;

  // If taskId is provided but no session name, use the task ID to generate the session name
  if (taskId && !session) {
    // Normalize the task ID format
    if (!taskId.startsWith('#')) {
      taskId = `#${taskId}`;
    }

    // Verify the task exists
    taskService = taskService || new TaskService({
      repoPath: repo || await resolveRepoPath({}),
      backend: 'markdown' // Default to markdown backend
    });

    const task = await taskService.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    session = `task${taskId}`;
  }

  if (!session) {
    throw new Error('Either session name or taskId must be provided');
  }

  // Check if session already exists
  const existingSession = await sessionDB.getSession(session);
  if (existingSession) {
    throw new Error(`Session '${session}' already exists`);
  }

  // Check if a session already exists for this task
  if (taskId) {
    const existingSessions = await sessionDB.listSessions();
    const taskSession = existingSessions.find((s: SessionRecord) => s.taskId === taskId);
    
    if (taskSession) {
      throw new Error(`A session for task ${taskId} already exists: '${taskSession.session}'`);
    }
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

  // Record the session first
  const sessionRecord = {
    session,
    repoUrl,
    branch: session,
    createdAt: new Date().toISOString(),
    ...(taskId ? { taskId } : {})
  };
  await sessionDB.addSession(sessionRecord);

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

  return { cloneResult, branchResult, sessionRecord };
} 

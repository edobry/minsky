import { GitService } from '../../domain/git.js';
import { SessionDB, type SessionRecord } from '../../domain/session.js';
import { TaskService } from '../../domain/tasks.js';
import { RepositoryBackendType } from '../../domain/repository.js';
import fs from 'fs';
import path from 'path';
import { resolveRepoPath as resolveRepoPathDefault, normalizeRepoName } from '../../domain/repo-utils.js';
import { normalizeTaskId } from '../../utils/task-utils.js';

// Default imports for optional parameters
const fsDefault = fs;
const pathDefault = path;

export interface StartSessionOptions {
  session?: string;
  repo?: string;
  taskId?: string;
  backend?: 'local' | 'remote' | 'github' | 'auto';
  branch?: string;
  github?: {
    token?: string;
    owner?: string;
    repo?: string;
  };
  noStatusUpdate?: boolean;
  gitService?: GitService;
  sessionDB?: SessionDB;
  fs?: typeof fs;
  path?: typeof path;
  resolveRepoPath?: typeof resolveRepoPathDefault;
  taskService?: TaskService;
}

export interface StartSessionResult {
  sessionRecord: SessionRecord;
  cloneResult: { workdir: string };
  branchResult: { branch: string };
  statusUpdateResult?: {
    previousStatus?: string;
    newStatus: string;
  };
}

export async function startSession({
  session,
  repo,
  taskId,
  backend = 'auto',
  branch,
  github,
  noStatusUpdate,
  gitService,
  sessionDB,
  fs,
  path,
  resolveRepoPath,
  taskService
}: StartSessionOptions): Promise<StartSessionResult> {
  gitService = gitService || new GitService();
  sessionDB = sessionDB || new SessionDB();
  fs = fs || fsDefault;
  path = path || pathDefault;
  resolveRepoPath = resolveRepoPath || resolveRepoPathDefault;

  // If taskId is provided but no session name, use the task ID to generate the session name
  if (taskId && !session) {
    // Normalize the task ID format
    taskId = normalizeTaskId(taskId);

    // Verify the task exists
    taskService = taskService || new TaskService({
      workspacePath: repo || await resolveRepoPath({}),
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

  // Auto-detect repository backend type if 'auto' is specified
  let backendType = backend;
  if (backend === 'auto') {
    // Determine backend type based on URL format
    if (repoUrl.startsWith('http://') || 
        repoUrl.startsWith('https://') || 
        repoUrl.startsWith('git@')) {
      
      // Further detect GitHub repositories
      if (repoUrl.includes('github.com')) {
        backendType = 'github';
      } else {
        backendType = 'remote';
      }
    } else {
      backendType = 'local';
    }
  }

  // The session creation approach follows these steps:
  // 1. First add the session to the DB (repoUrl needed)
  // 2. Then clone the repo (session name needed)
  // 3. Then create a branch (session name needed)
  
  // Extract the repository name
  const repoName = normalizeRepoName(repoUrl);
  
  // First record the session in the DB
  await sessionDB.addSession({
    session,
    repoUrl,
    repoName,
    createdAt: new Date().toISOString(),
    taskId,
    backendType: backendType as 'local' | 'remote' | 'github',
    github,
    branch
  });

  // Prepare clone options with the correct backend type
  const cloneOptions = {
    repoUrl,
    session,
    backend: backendType as 'local' | 'remote' | 'github',
    github,
    branch
  };

  // Now clone the repo
  const cloneResult = await gitService.clone(cloneOptions);

  // Create a branch based on the session name
  const branchResult = await gitService.branch({
    session,
    branch: session
  });

  // Update task status if needed
  let statusUpdateResult;
  if (taskId && !noStatusUpdate) {
    const taskService = new TaskService({
      workspacePath: cloneResult.workdir,
      backend: 'markdown' // Default to markdown backend
    });

    const currentStatus = await taskService.getTaskStatus(taskId);
    
    // Only update if the status is not already IN-PROGRESS or higher
    if (!currentStatus || currentStatus === 'TODO') {
      await taskService.setTaskStatus(taskId, 'IN-PROGRESS');
      statusUpdateResult = {
        previousStatus: currentStatus,
        newStatus: 'IN-PROGRESS'
      };
    }
  }

  // Prepare result
  const result: StartSessionResult = {
    sessionRecord: { 
      session, 
      repoUrl, 
      repoName, 
      branch: session, 
      createdAt: new Date().toISOString(),
      taskId,
      backendType: backendType as 'local' | 'remote' | 'github',
      github
    },
    cloneResult,
    branchResult
  };

  if (statusUpdateResult) {
    result.statusUpdateResult = statusUpdateResult;
  }

  return result;
} 

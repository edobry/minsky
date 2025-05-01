import { GitService } from '../../domain/git';
import { SessionDB } from '../../domain/session';
import { TaskService } from '../../domain/tasks';
import { normalizeTaskId } from '../../utils/task-utils';
import { resolveRepoPath } from '../../domain/repo-utils';
import { normalizeRepoName } from '../../domain/repo-utils';
import { randomBytes } from 'crypto';

export interface StartSessionOptions {
  repo?: string;
  session?: string;
  branch?: string;
  taskId?: string;
}

export async function startSession(options: StartSessionOptions): Promise<string> {
  const { repo: repoUrl, session: sessionName, branch, taskId } = options;

  // Validate task ID if provided
  if (taskId) {
    const taskService = new TaskService({
      backend: "markdown" // Default to markdown backend
    });

    const task = await taskService.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Check if a session already exists for this task
    const sessionDb = new SessionDB();
    const existingTaskSession = await sessionDb.getSessionByTaskId(taskId);
    if (existingTaskSession) {
      throw new Error(`A session for task '${taskId}' already exists: ${existingTaskSession.session}`);
    }
  }

  // Generate a session name if not provided
  const session = sessionName || `session-${randomBytes(3).toString("hex")}`;

  // Check if session already exists
  const sessionDB = new SessionDB();
  const existingSession = await sessionDB.getSession(session);
  if (existingSession) {
    throw new Error(`Session '${session}' already exists`);
  }

  // Get repository URL
  let finalRepoUrl = repoUrl;
  if (!finalRepoUrl) {
    try {
      const repoPath = await resolveRepoPath();
      finalRepoUrl = `file://${repoPath}`;
    } catch (err) {
      throw new Error("No repository URL provided and not in a git repository");
    }
  } else if (finalRepoUrl.startsWith("/")) {
    // Convert local path to file:// URL
    finalRepoUrl = `file://${finalRepoUrl}`;
  }

  // Create the session
  const git = new GitService();
  const repoPath = await git.clone({
    repoUrl: finalRepoUrl,
    session,
    branch,
    taskId
  });

  return repoPath;
} 

import { createSessionProvider } from "../../session";
import { createGitService } from "../../git";
import { TaskService, TASK_STATUS } from "../../tasks";
import { getCurrentSession } from "../../workspace";
import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import { 
  SessionApprovalResult,
  SessionProviderInterface,
  SessionApprovalDependencies 
} from "../types";
import { 
  MinskyError, 
  ResourceNotFoundError, 
  ValidationError,
  getErrorMessage,
} from "../../errors/index";
import { log } from "../../utils/logger";
import * as WorkspaceUtils from "../../workspace";

/**
 * Approves a session (merges PR) based on parameters
 */
export async function approveSessionFromParams(
  params: {
    session?: string;
    task?: string;
    repo?: string;
    json?: boolean;
  },
  depsInput?: SessionApprovalDependencies
): Promise<SessionApprovalResult> {
  const { session, task, repo, json } = params;

  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    gitService: depsInput?.gitService || createGitService(),
    taskService: depsInput?.taskService || {
      setTaskStatus: async (taskId: string, status: string) => {
        const taskService = new TaskService();
        return taskService.setTaskStatus(taskId, status);
      },
      getBackendForTask: async (taskId: string) => {
        const taskService = new TaskService();
        return taskService.getBackendForTask(taskId);
      },
    },
    workspaceUtils: depsInput?.workspaceUtils || WorkspaceUtils,
    getCurrentSession: depsInput?.getCurrentSession || getCurrentSession,
  };

  try {
    // Use unified session context resolver with auto-detection support
    const resolvedContext = await resolveSessionContextWithFeedback({
      session,
      task,
      repo,
      sessionProvider: deps.sessionDB,
      allowAutoDetection: true,
    });

    // Get the session details using the resolved session name
    const sessionRecord = await deps.sessionDB.getSession(resolvedContext.sessionName);
    
    if (!sessionRecord) {
      throw new ResourceNotFoundError(`Session '${resolvedContext.sessionName}' not found`);
    }

    // Get session working directory
    const workdir = await deps.sessionDB.getSessionWorkdir(resolvedContext.sessionName);

    // Get current branch (should be the PR branch)
    const currentBranch = await deps.gitService.getCurrentBranch(workdir);
    
    // Get base branch
    let baseBranch = "main";
    try {
      baseBranch = await deps.gitService.fetchDefaultBranch(workdir);
    } catch (error) {
      log.debug("Could not fetch default branch, using 'main'", { error });
    }

    // Switch to base branch
    await deps.gitService.execInRepository(workdir, `git checkout ${baseBranch}`);
    
    // Pull latest changes
    await deps.gitService.pullLatest(workdir);
    
    // Merge the PR branch
    const mergeResult = await deps.gitService.mergeBranch(workdir, currentBranch);
    
    if (mergeResult.conflicts) {
      throw new MinskyError(`Merge conflicts detected while merging ${currentBranch} into ${baseBranch}`);
    }

    // Get merge commit hash
    const commitHash = await deps.gitService.execInRepository(workdir, "git rev-parse HEAD");
    
    // Push the merged changes
    await deps.gitService.push({
      repoPath: workdir,
      remote: "origin",
    });

    // Clean up PR branch
    try {
      await deps.gitService.execInRepository(workdir, `git branch -d ${currentBranch}`);
      await deps.gitService.execInRepository(workdir, `git push origin --delete ${currentBranch}`);
    } catch (error) {
      log.debug("Could not clean up PR branch", { error });
    }

    // Update task status if applicable
    if (sessionRecord.taskId && deps.taskService.setTaskStatus) {
      try {
        await deps.taskService.setTaskStatus(sessionRecord.taskId, TASK_STATUS.COMPLETED);
        log.info(`Task ${sessionRecord.taskId} status updated to COMPLETED`);
      } catch (error) {
        log.debug("Could not update task status", { error });
      }
    }

    const result: SessionApprovalResult = {
      session: resolvedContext.sessionName,
      commitHash: commitHash.trim(),
      mergeDate: new Date().toISOString(),
      mergedBy: "minsky", // Could be enhanced to get actual user
      baseBranch,
      prBranch: currentBranch,
      taskId: sessionRecord.taskId,
    };

    log.info(`Session '${resolvedContext.sessionName}' approved and merged successfully`);
    
    return result;
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

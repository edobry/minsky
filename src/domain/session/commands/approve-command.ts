import { createSessionProvider } from "../../session";
import { createGitService } from "../../git";
import { TaskService, TASK_STATUS, normalizeTaskId } from "../../tasks";
import { getCurrentSession } from "../../workspace";
import { resolveSessionContextWithFeedback } from "../session-context-resolver";
import {
  SessionApprovalResult,
  SessionProviderInterface,
  SessionApprovalDependencies,
} from "../types";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
} from "../../../errors/index";
import { log } from "../../../utils/logger";
import * as WorkspaceUtils from "../../workspace";
import { gitPushWithTimeout, execGitWithTimeout } from "../../../utils/git-exec";

/**
 * Approves a session (merges PR) based on parameters
 */
export async function sessionApprove(
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
      throw new MinskyError(
        `Merge conflicts detected while merging ${currentBranch} into ${baseBranch}`
      );
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
      await execGitWithTimeout("delete-remote-branch", `push origin --delete ${currentBranch}`, {
        workdir,
      });
    } catch (error) {
      log.debug("Could not clean up PR branch", { error });
    }

    // Update task status if applicable
    if (sessionRecord.taskId && deps.taskService.setTaskStatus) {
      try {
        await deps.taskService.setTaskStatus(sessionRecord.taskId, TASK_STATUS.DONE);
        log.info(`Task ${sessionRecord.taskId} status updated to DONE`);

        // Check for uncommitted changes after task status update
        const statusOutput = await deps.gitService.execInRepository(
          workdir,
          "git status --porcelain"
        );

        if (statusOutput.trim()) {
          // There are uncommitted changes, commit them
          const taskId = normalizeTaskId(sessionRecord.taskId) || sessionRecord.taskId;

          // Stage the tasks file
          await deps.gitService.execInRepository(workdir, "git add process/tasks.md");

          // Commit the task status update
          try {
            await deps.gitService.execInRepository(
              workdir,
              `git commit -m "chore(${taskId}): update task status to DONE"`
            );
            log.info(`Task status commit for ${taskId} created successfully`);
          } catch (commitError) {
            // Handle pre-commit hook failures gracefully
            const errorMsg = getErrorMessage(commitError as Error);
            if (errorMsg.includes("pre-commit") || errorMsg.includes("lint")) {
              log.warn("⚠️  Pre-commit linting detected issues during task status commit");
              log.warn("📝 Task status was updated but commit had linting issues");
              log.warn("💡 The task is marked as DONE - you can fix linting issues separately");
              log.warn("Task status commit failed due to pre-commit checks", {
                taskId,
                error: errorMsg,
              });
              // Don't re-throw - the task status update succeeded, just the commit had linting issues
            } else {
              // Re-throw for other types of commit errors
              throw commitError;
            }
          }

          // Try to push the commit if it succeeded
          try {
            await gitPushWithTimeout("origin", undefined, { workdir });
            log.info(`Task status commit for ${taskId} pushed successfully`);
          } catch (pushError) {
            log.warn("Failed to push task status commit", {
              taskId,
              error: getErrorMessage(pushError),
            });
          }
        }
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
      taskId: sessionRecord.taskId
        ? normalizeTaskId(sessionRecord.taskId) || sessionRecord.taskId
        : "",
      isNewlyApproved: true,
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

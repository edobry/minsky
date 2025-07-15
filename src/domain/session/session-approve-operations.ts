import { existsSync, rmSync } from "fs";
import { readFile, writeFile, mkdir, access, rename } from "fs/promises";
import { join } from "path";
import { getMinskyStateDir, getSessionDir } from "../../utils/paths";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
  createCommandFailureMessage,
  createErrorContext
} from "../../errors/index";
import { taskIdSchema } from "../../schemas/common";
import { log } from "../../utils/logger";
import { type GitServiceInterface } from "../git";
import { createGitService } from "../git";
import { TaskService, TASK_STATUS, type TaskServiceInterface } from "../tasks";
import { execAsync } from "../../utils/exec";
import {
  type WorkspaceUtilsInterface,
  getCurrentSession,
  getCurrentSessionContext,
} from "../workspace";
import * as WorkspaceUtils from "../workspace";
import { createSessionProvider, type SessionProviderInterface } from "./session-db-adapter";
import { updatePrStateOnMerge } from "./session-update-operations";

/**
 * Approves a session by merging its PR branch into the main branch
 * and updating the task status to DONE if applicable
 */
export async function approveSessionImpl(
  params: {
    session?: string;
    task?: string;
    repo?: string;
    json?: boolean;
  },
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitServiceInterface;
    taskService?: {
      setTaskStatus?: (taskId: string, status: string) => Promise<any>;
      getTaskStatus?: (taskId: string) => Promise<string | undefined>;
      getBackendForTask?: (taskId: string) => Promise<any>;
    };
    workspaceUtils?: any;
    getCurrentSession?: (repoPath: string) => Promise<string | null>;
  }
): Promise<{
  session: string;
  commitHash: string;
  mergeDate: string;
  mergedBy: string;
  baseBranch: string;
  prBranch: string;
  taskId?: string;
  isNewlyApproved: boolean;
}> {
  let sessionNameToUse = params.session;
  let taskId: string | undefined;

  // Set up session provider (use injected one or create default)
  const sessionDB = depsInput?.sessionDB || createSessionProvider();

  // Try to get session from task ID if provided
  if (params.task && !sessionNameToUse) {
    const taskIdToUse = taskIdSchema.parse(params.task);
    taskId = taskIdToUse;

    // Get session by task ID
    const session = await sessionDB.getSessionByTaskId(taskIdToUse);
    if (!session) {
      throw new ResourceNotFoundError(
        `No session found for task ${taskIdToUse}`,
        "task",
        taskIdToUse
      );
    }
    sessionNameToUse = session.session;
  }

  // Try to auto-detect session from repo path if no session name or task is provided
  if (!sessionNameToUse && params.repo) {
    const getCurrentSessionFunc = depsInput?.getCurrentSession || getCurrentSession;
    const detectedSession = await getCurrentSessionFunc(params.repo);
    if (detectedSession) {
      sessionNameToUse = detectedSession;
    }
  }

  // Validate that we have a session to work with
  if (!sessionNameToUse) {
    throw new ValidationError("No session detected. Please provide a session name or task ID");
  }

  // Get the session record
  const sessionRecord = await sessionDB.getSession(sessionNameToUse);
  if (!sessionRecord) {
    throw new ResourceNotFoundError(
      `Session "${sessionNameToUse}" not found`,
      "session",
      sessionNameToUse
    );
  }

  // BUG FIX: Use the original repo URL/path for task updates, not session workspace
  const originalRepoPath = params.repo || sessionRecord.repoUrl || process.cwd();

  // Set up default dependencies with the correct repo path
  const deps = {
    sessionDB: depsInput?.sessionDB || sessionDB,
    gitService: depsInput?.gitService || createGitService(),
    taskService:
      depsInput?.taskService ||
      new TaskService({
        workspacePath: originalRepoPath,
        backend: "markdown",
      }),
    workspaceUtils: depsInput?.workspaceUtils || WorkspaceUtils,
    getCurrentSession: depsInput?.getCurrentSession || getCurrentSession,
  };

  // If no taskId from params, use the one from session record
  if (!taskId && sessionRecord.taskId) {
    taskId = sessionRecord.taskId;
  }

  // BUG FIX: Use originalRepoPath for all git operations instead of session workspace
  // This ensures approval operations happen in the main repository, not the session workspace
  // The session workspace state becomes irrelevant for approval
  const workingDirectory = originalRepoPath;

  // Determine PR branch name (pr/<session-name>)
  const featureBranch = sessionNameToUse;
  const prBranch = `pr/${featureBranch}`;
  const baseBranch = "main"; // Default base branch, could be made configurable

  // Early exit check: If task is already DONE and PR branch doesn't exist, session is already complete
  if (taskId && deps.taskService.getTaskStatus) {
    try {
      const currentStatus = await deps.taskService.getTaskStatus(taskId);
      if (currentStatus === TASK_STATUS.DONE) {
        // Check if PR branch exists
        try {
          await deps.gitService.execInRepository(workingDirectory, `git show-ref --verify --quiet refs/heads/${prBranch}`);
          // PR branch exists, continue with normal flow
          log.debug(`PR branch ${prBranch} exists, continuing with normal flow`);
        } catch (_branchError) {
          // PR branch doesn't exist and task is already DONE - session is complete
          log.debug(`Session ${sessionNameToUse} is already complete: task ${taskId} is DONE and PR branch ${prBranch} doesn't exist`);

          // Get current HEAD info for the response
          const commitHash = (
            await deps.gitService.execInRepository(workingDirectory, "git rev-parse HEAD")
          ).trim();
          const mergedBy = (
            await deps.gitService.execInRepository(workingDirectory, "git config user.name")
          ).trim();
          const mergeDate = new Date().toISOString();

          return {
            session: sessionNameToUse,
            commitHash,
            mergeDate,
            mergedBy,
            baseBranch,
            prBranch,
            taskId,
            isNewlyApproved: false,
          };
        }
      } else {
        log.debug(`Task ${taskId} is not DONE (status: ${currentStatus}), continuing with normal flow`);
      }
    } catch (_statusError) {
      // If we can't check the status, continue with normal flow
      log.debug(`Could not check task status for ${taskId}, continuing with normal approval flow`);
    }
  }

  try {
    // Execute git commands to merge the PR branch in the main repository
    // First, check out the base branch
    await deps.gitService.execInRepository(workingDirectory, `git checkout ${baseBranch}`);
    // Fetch latest changes
    await deps.gitService.execInRepository(workingDirectory, "git fetch origin");

    // Check if the PR branch has already been merged
    let isNewlyApproved = true;
    let commitHash: string = "";
    let mergeDate: string = "";
    let mergedBy: string = "";

    try {
      // Check if the PR branch exists locally
      await deps.gitService.execInRepository(workingDirectory, `git show-ref --verify --quiet refs/heads/${prBranch}`);

      // Get the commit hash of the PR branch
      const _prBranchCommitHash = (
        await deps.gitService.execInRepository(workingDirectory, `git rev-parse ${prBranch}`)
      ).trim();

      // REMOVED: Problematic race condition check
      // Instead of checking git merge-base --is-ancestor, let git merge handle it
      // This avoids the race condition where the check can fail during merge process

      // Attempt the merge - if it fails because already merged, git will tell us
      try {
        await deps.gitService.execInRepository(workingDirectory, `git merge --ff-only ${prBranch}`);

        // If merge succeeds, it's newly approved
        isNewlyApproved = true;

        // Get commit hash and date for the new merge
        commitHash = (
          await deps.gitService.execInRepository(workingDirectory, "git rev-parse HEAD")
        ).trim();
        mergeDate = new Date().toISOString();
        mergedBy = (
          await deps.gitService.execInRepository(workingDirectory, "git config user.name")
        ).trim();

        // Push the changes
        await deps.gitService.execInRepository(workingDirectory, `git push origin ${baseBranch}`);

        // Delete the PR branch from remote only if it exists there
        try {
          // Check if remote branch exists first using execAsync directly to avoid error logging
          // This is expected to fail if the branch doesn't exist, which is normal
          await execAsync(`git show-ref --verify --quiet refs/remotes/origin/${prBranch}`, {
            cwd: workingDirectory
          });
          // If it exists, delete it
          await deps.gitService.execInRepository(
            workingDirectory,
            `git push origin --delete ${prBranch}`
          );
        } catch (error) {
          // Remote branch doesn't exist, which is fine - just log it
          log.debug(`Remote PR branch ${prBranch} doesn't exist, skipping deletion`);
        }

        // Clean up local branches after successful merge
        await cleanupLocalBranches(deps.gitService, workingDirectory, prBranch, sessionNameToUse, taskId);

        // Update PR state to reflect merge
        await updatePrStateOnMerge(sessionNameToUse, deps.sessionDB);

      } catch (mergeError) {
        // Merge failed - check if it's because already merged
        const errorMessage = getErrorMessage(mergeError as Error);

        if (errorMessage.includes("Already up to date") || errorMessage.includes("nothing to commit")) {
          // PR branch has already been merged
          isNewlyApproved = false;
          log.debug(`PR branch ${prBranch} has already been merged`);

          // Update PR state to reflect it's already merged
          await updatePrStateOnMerge(sessionNameToUse, deps.sessionDB);

          // Get current HEAD info for already merged case
          commitHash = (
            await deps.gitService.execInRepository(workingDirectory, "git rev-parse HEAD")
          ).trim();

          // For already merged PRs, try to get the merge commit info
          try {
            const mergeCommitInfo = await deps.gitService.execInRepository(
              workingDirectory,
              `git log --merges --oneline --grep="Merge.*${prBranch}" -n 1 --format="%H|%ai|%an"`
            );
            if (mergeCommitInfo.trim()) {
              const parts = mergeCommitInfo.trim().split("|");
              if (parts.length >= 3 && parts[0] && parts[1] && parts[2]) {
                commitHash = parts[0];
                mergeDate = new Date(parts[1]).toISOString();
                mergedBy = parts[2];
              } else {
                // Fallback to current HEAD info if format is unexpected
                mergeDate = new Date().toISOString();
                mergedBy = (
                  await deps.gitService.execInRepository(workingDirectory, "git config user.name")
                ).trim();
              }
            } else {
              // Fallback to current HEAD info if we can't find the merge commit
              mergeDate = new Date().toISOString();
              mergedBy = (
                await deps.gitService.execInRepository(workingDirectory, "git config user.name")
              ).trim();
            }
          } catch (error) {
            // Fallback to current HEAD info
            mergeDate = new Date().toISOString();
            mergedBy = (
              await deps.gitService.execInRepository(workingDirectory, "git config user.name")
            ).trim();
          }
        } else {
          // Some other merge error - re-throw it
          throw mergeError;
        }
      }
    } catch (error) {
      // PR branch doesn't exist locally, it might have been already merged and cleaned up
      isNewlyApproved = false;
      log.debug(`PR branch ${prBranch} doesn't exist locally, assuming already merged`);

      // Get current HEAD info
      commitHash = (
        await deps.gitService.execInRepository(workingDirectory, "git rev-parse HEAD")
      ).trim();
      mergeDate = new Date().toISOString();
      mergedBy = (
        await deps.gitService.execInRepository(workingDirectory, "git config user.name")
      ).trim();
    }

    // The merge logic has been moved inside the try block above
    // No need for separate isNewlyApproved check here

    // Create merge info
    const mergeInfo = {
      session: sessionNameToUse,
      commitHash,
      mergeDate,
      mergedBy,
      baseBranch,
      prBranch,
      taskId,
      isNewlyApproved,
    };

    // Update task status to DONE if we have a task ID and it's not already DONE
    if (taskId && deps.taskService.setTaskStatus && deps.taskService.getTaskStatus) {
      try {
        // Check current status first to avoid unnecessary updates
        const currentStatus = await deps.taskService.getTaskStatus(taskId);

        if (currentStatus !== TASK_STATUS.DONE) {
          log.debug(`Updating task ${taskId} status from ${currentStatus} to DONE`);
          await deps.taskService.setTaskStatus(taskId, TASK_STATUS.DONE);

          // After updating task status, check if there are uncommitted changes that need to be committed
          try {
            const statusOutput = await deps.gitService.execInRepository(workingDirectory, "git status --porcelain");
            const hasUncommittedChanges = statusOutput.trim().length > 0;

            if (hasUncommittedChanges) {
              log.debug("Task status update created uncommitted changes, committing them");

              // Stage the tasks.md file (or any other changed files from task status update)
              await deps.gitService.execInRepository(workingDirectory, "git add process/tasks.md");

              // Commit the task status update
              await deps.gitService.execInRepository(workingDirectory, `git commit -m "Update task ${taskId} status to DONE"`);

              // Push the commit
              await deps.gitService.execInRepository(workingDirectory, "git push");

              log.debug(`Committed and pushed task ${taskId} status update`);
            } else {
              log.debug("No uncommitted changes from task status update");
            }
          } catch (commitError) {
            // Log the error but don't fail the whole operation
            const errorMsg = `Failed to commit task status update: ${getErrorMessage(commitError as Error)}`;
            log.error(errorMsg, { taskId, error: commitError });
            log.cli(`Warning: ${errorMsg}`);
          }
        } else {
          log.debug(`Task ${taskId} is already DONE, skipping status update`);
        }
      } catch (error) {
        // BUG FIX: Use proper logging instead of console.error and make error visible
        const errorMsg = `Failed to update task status: ${getErrorMessage(error)}`;
        log.error(errorMsg, { taskId, error });
        log.cli(`Warning: ${errorMsg}`);
        // Still don't fail the whole operation, but now errors are visible
      }
    }

    return mergeInfo;
  } catch (error) {
    if (error instanceof MinskyError) {
      throw error;
    } else {
      throw new MinskyError(
        `Failed to approve session: ${getErrorMessage(error)}`
      );
    }
  }
}

/**
 * Clean up local branches after successful merge
 * Handles failures gracefully to not break the overall approval process
 */
async function cleanupLocalBranches(
  gitService: GitServiceInterface,
  workingDirectory: string,
  prBranch: string,
  sessionName: string,
  taskId?: string
): Promise<void> {
  // Extract task ID from session name if not provided and session follows task# pattern
  const taskBranchName = taskId ? taskId.replace("#", "") : sessionName.replace("task#", "");

  // Clean up the PR branch (e.g., pr/task#265)
  try {
    await gitService.execInRepository(workingDirectory, `git branch -d ${prBranch}`);
    log.debug(`Successfully deleted local PR branch: ${prBranch}`);
  } catch (error) {
    // Log but don't fail the operation if branch cleanup fails
    log.debug(`Failed to delete local PR branch ${prBranch}: ${getErrorMessage(error)}`);
  }

  // Clean up the task branch (e.g., task#265 or 265)
  // Try various possible branch name formats
  const possibleTaskBranches = [];

  // Add sessionName if it looks like a task branch (task#265)
  if (sessionName && sessionName !== prBranch) {
    possibleTaskBranches.push(sessionName);
  }

  // Add numeric version if we have a task ID (265)
  if (taskBranchName && taskBranchName !== sessionName) {
    possibleTaskBranches.push(taskBranchName);
  }

  // Add task prefix version (task265, task#265)
  if (taskBranchName) {
    possibleTaskBranches.push(`task${taskBranchName}`);
    possibleTaskBranches.push(`task#${taskBranchName}`);
  }

  // Filter out duplicates, empty strings, PR branch, and invalid branch names
  const uniqueBranches = [...new Set(possibleTaskBranches)].filter(
    branch => branch && branch !== prBranch && !branch.startsWith("#")
  );

  for (const branch of uniqueBranches) {
    try {
      await gitService.execInRepository(workingDirectory, `git branch -d ${branch}`);
      log.debug(`Successfully deleted local task branch: ${branch}`);
      break; // Stop after first successful deletion
    } catch (error) {
      // Log but continue trying other branch names
      log.debug(`Failed to delete local task branch ${branch}: ${getErrorMessage(error)}`);
    }
  }
} 

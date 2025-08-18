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
  createErrorContext,
} from "../../errors/index";
import { taskIdSchema as TaskIdSchema } from "../../schemas/common";
import { log } from "../../utils/logger";
import { type GitServiceInterface } from "../git";
import { createGitService } from "../git";
import {
  TaskService,
  TASK_STATUS,
  type TaskServiceInterface,
  createConfiguredTaskService,
} from "../tasks";
import { execAsync } from "../../utils/exec";
import {
  type WorkspaceUtilsInterface,
  getCurrentSession,
  getCurrentSessionContext,
} from "../workspace";
import * as WorkspaceUtils from "../workspace";
import { createSessionProvider } from "../session";
import type { SessionProviderInterface } from "../session";
import type { SessionRecord } from "../session";
import { updatePrStateOnMerge } from "./session-update-operations";
import { createRepositoryBackendForSession } from "./repository-backend-detection";
import {
  createRepositoryBackend,
  RepositoryBackendType,
  type RepositoryBackend,
  type RepositoryBackendConfig,
} from "../repository/index";

/**
 * Create repository backend from session record's stored configuration
 * instead of auto-detecting from git remote
 */
async function createRepositoryBackendFromSession(
  sessionRecord: SessionRecord
): Promise<RepositoryBackend> {
  // Determine backend type from session configuration
  let backendType: RepositoryBackendType;

  if (sessionRecord.backendType) {
    // Use explicitly set backend type
    switch (sessionRecord.backendType) {
      case "github":
        backendType = RepositoryBackendType.GITHUB;
        break;
      case "remote":
        backendType = RepositoryBackendType.REMOTE;
        break;
      case "local":
      default:
        backendType = RepositoryBackendType.LOCAL;
        break;
    }
  } else {
    // Infer backend type from repoUrl format for backward compatibility
    if (sessionRecord.repoUrl.startsWith("/") || sessionRecord.repoUrl.startsWith("file://")) {
      backendType = RepositoryBackendType.LOCAL;
    } else if (sessionRecord.repoUrl.includes("github.com")) {
      backendType = RepositoryBackendType.GITHUB;
    } else {
      backendType = RepositoryBackendType.REMOTE;
    }
  }

  const config: RepositoryBackendConfig = {
    type: backendType,
    repoUrl: sessionRecord.repoUrl,
  };

  // Add GitHub-specific configuration if available
  // For GitHub, owner/repo will be derived from repoUrl by the backend

  return await createRepositoryBackend(config);
}

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
    noStash?: boolean;
  },
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitServiceInterface;
    taskService?: {
      setTaskStatus?: (taskId: string, status: string) => Promise<any>;
      getTaskStatus?: (taskId: string) => Promise<string | undefined>;
      getBackendForTask?: (taskId: string) => Promise<any>;
      getTask?: (taskId: string) => Promise<any>;
    };
    workspaceUtils?: any;
    getCurrentSession?: (repoPath: string) => Promise<string | null>;
    createRepositoryBackend?: (sessionRecord: SessionRecord) => Promise<RepositoryBackend>;
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
  // Provide immediate user feedback - don't wait for operations to start
  if (!params.json) {
    log.cli("🔄 Starting session approval...");
  }

  let sessionNameToUse = params.session;
  let taskId: string | undefined;

  // Set up session provider (use injected one or create default)
  const sessionDB = depsInput?.sessionDB || createSessionProvider();

  // Try to get session from task ID if provided
  if (params.task && !sessionNameToUse) {
    if (!params.json) {
      log.cli("🔍 Resolving session from task ID...");
    }

    const taskIdToUse = TaskIdSchema.parse(params.task);
    taskId = taskIdToUse;

    // **BUG FIX**: Validate task existence BEFORE checking for session
    // Use injected TaskService or create default one for validation
    const taskService = depsInput?.taskService?.getTask
      ? depsInput.taskService
      : await createConfiguredTaskService({
          workspacePath: params.repo || process.cwd(),
        });

    try {
      const task = await (taskService.getTask
        ? taskService.getTask(taskIdToUse)
        : (taskService as any).getTask(taskIdToUse));
      if (!task) {
        // Task doesn't exist - provide clear, concise error
        throw new ResourceNotFoundError(
          `❌ Task not found: ${taskIdToUse}

The specified task does not exist.

💡 Available options:
• Run 'minsky tasks list' to see all available tasks
• Check your task ID for typos
• Use 'minsky session list' to see tasks with active sessions`,
          "task",
          taskIdToUse
        );
      }
    } catch (error) {
      // If task validation fails, re-throw with clear error
      if (error instanceof ResourceNotFoundError) {
        throw error;
      }
      // For other errors (like TaskService issues), provide generic error
      throw new ResourceNotFoundError(
        `❌ Could not validate task: ${taskIdToUse}

Unable to check if the task exists.

💡 Available options:
• Run 'minsky tasks list' to see all available tasks
• Check your task ID for typos`,
        "task",
        taskIdToUse
      );
    }

    // Task exists, now check for session
    const session = await sessionDB.getSessionByTaskId(taskIdToUse);
    if (!session) {
      // Task exists but no session - provide clear, concise error
      throw new ResourceNotFoundError(
        `❌ No session found for task ${taskIdToUse}

The task exists but has no associated session to approve.

💡 Available options:
• Run 'minsky session start --task ${taskIdToUse}' to create a session
• Use 'minsky session list' to see tasks with active sessions`,
        "session",
        taskIdToUse
      );
    }
    sessionNameToUse = session.session;
  }

  // Try to auto-detect session from repo path if no session name or task is provided
  if (!sessionNameToUse && params.repo) {
    if (!params.json) {
      log.cli("🔍 Auto-detecting session from repository...");
    }

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
      (await createConfiguredTaskService({
        workspacePath: originalRepoPath,
      })),
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

  // Determine PR branch name (local/remote only). GitHub path will delegate to backend
  const featureBranch = sessionNameToUse;
  const prBranch = `pr/${featureBranch}`;
  const baseBranch = "main"; // Default base branch, could be made configurable

  // Early exit check (non-GitHub only): If DONE and PR branch missing, session is complete
  if (taskId && deps.taskService.getTaskStatus && sessionRecord.backendType !== "github") {
    try {
      const currentStatus = await deps.taskService.getTaskStatus(taskId);
      if (currentStatus === TASK_STATUS.DONE) {
        // Check if PR branch exists
        try {
          await deps.gitService.execInRepository(
            workingDirectory,
            `git show-ref --verify --quiet refs/heads/${prBranch}`
          );
          // PR branch exists, continue with normal flow
          log.debug(`PR branch ${prBranch} exists, continuing with normal flow`);
        } catch (_branchError) {
          // PR branch doesn't exist and task is already DONE - session is complete
          log.debug(
            `Session ${sessionNameToUse} is already complete: task ${taskId} is DONE and PR branch ${prBranch} doesn't exist`
          );

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
        log.debug(
          `Task ${taskId} is not DONE (status: ${currentStatus}), continuing with normal flow`
        );
      }
    } catch (_statusError) {
      // If we can't check the status, continue with normal flow
      log.debug(`Could not check task status for ${taskId}, continuing with normal approval flow`);
    }
  }

  // Track whether we stashed changes for restoration logic (non-GitHub only)
  let hasStashedChanges = false;

  // Initialize merge tracking variables
  let isNewlyApproved = true;
  let commitHash: string = "";
  let mergeDate: string = "";
  let mergedBy: string = "";

  try {
    // Use repository backend from session configuration instead of auto-detecting
    if (!params.json) {
      log.cli("🔍 Using session's repository configuration...");
    }

    // Create repository backend from session record's stored configuration
    const createBackendFn =
      depsInput?.createRepositoryBackend || createRepositoryBackendFromSession;
    const repositoryBackend = await createBackendFn(sessionRecord);
    const backendType = repositoryBackend.getType();

    if (!params.json) {
      log.cli(`📦 Using ${backendType} repository backend for merge`);
    }

    // Check for uncommitted changes and stash if needed (non-GitHub only)
    if (!params.noStash && sessionRecord.backendType !== "github") {
      try {
        const hasUncommittedChanges = await deps.gitService.hasUncommittedChanges(workingDirectory);
        if (hasUncommittedChanges) {
          if (!params.json) {
            log.cli("📦 Stashing uncommitted changes...");
          }
          log.debug("Stashing uncommitted changes", { workdir: workingDirectory });

          const stashResult = await deps.gitService.stashChanges(workingDirectory);
          hasStashedChanges = stashResult.stashed;

          if (hasStashedChanges && !params.json) {
            log.cli("✅ Changes stashed successfully");
          }
          log.debug("Changes stashed", { stashed: hasStashedChanges });
        }
      } catch (statusError) {
        // If we can't check/stash status, continue but might fail later with less friendly error
        log.debug("Could not check/stash git status before approval", {
          error: getErrorMessage(statusError),
        });
      }
    }

    // Determine PR identifier based on backend type
    let prIdentifier: string | number = prBranch; // default
    if (backendType === "github") {
      // For GitHub, backend will resolve PR number from session context; leave identifier undefined
      // Some backends require an identifier; we pass session via second argument
      prIdentifier = sessionNameToUse;
    }

    if (!params.json) {
      log.cli(`🔀 Merging pull request using ${backendType} backend...`);
    }

    // Use repository backend to merge the pull request
    let mergeResult;
    try {
      mergeResult = await repositoryBackend.mergePullRequest(prIdentifier, sessionNameToUse);
      isNewlyApproved = true;
    } catch (mergeError) {
      const errorMessage = getErrorMessage(mergeError);

      // Handle "Already up to date" as a successful case - PR was already merged
      if (errorMessage.includes("Already up to date")) {
        log.debug("PR is already merged, treating as successful approval");
        // Create a mock merge result for already-merged PR
        mergeResult = {
          commitHash: "already-merged",
          mergeDate: new Date().toISOString(),
          mergedBy: "already-merged",
        };
        isNewlyApproved = false; // Not newly approved, just already merged
      } else {
        // For any other merge error, re-throw to maintain existing behavior
        throw mergeError;
      }
    }

    // Extract merge information from repository backend response
    commitHash = mergeResult.commitHash;
    mergeDate = mergeResult.mergeDate;
    mergedBy = mergeResult.mergedBy;

    if (!params.json) {
      if (backendType === "github") {
        log.cli(`✅ GitHub PR merged successfully!`);
        log.cli(`📝 Commit: ${commitHash.substring(0, 8)}...`);
      } else {
        log.cli(`✅ PR branch merged successfully!`);
        log.cli(`📝 Merge commit: ${commitHash.substring(0, 8)}...`);
      }
    }

    log.debug("Repository backend merge completed", {
      backendType,
      commitHash,
      mergeDate,
      mergedBy,
      prBranch,
      baseBranch,
    });

    // Update PR state to reflect merge
    await updatePrStateOnMerge(sessionNameToUse, deps.sessionDB);

    // Continue with existing cleanup and task status logic...

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
            const statusOutput = await deps.gitService.execInRepository(
              workingDirectory,
              "git status --porcelain"
            );
            const hasUncommittedChanges = statusOutput.trim().length > 0;

            if (hasUncommittedChanges) {
              log.debug("Task status update created uncommitted changes, committing them");

              // Stage the tasks.md file (or any other changed files from task status update)
              await deps.gitService.execInRepository(workingDirectory, "git add process/tasks.md");

              // Commit the task status update with conventional commits format
              try {
                await deps.gitService.execInRepository(
                  workingDirectory,
                  `git commit -m "chore(${taskId}): update task status to DONE"`
                );
                log.debug(`Committed task ${taskId} status update`);
              } catch (commitError) {
                // Handle pre-commit hook failures gracefully
                const errorMsg = getErrorMessage(commitError as Error);
                if (errorMsg.includes("pre-commit") || errorMsg.includes("lint")) {
                  // Parse linter output to show clean summary
                  const errorCount = (errorMsg.match(/error/g) || []).length;
                  const warningCount = (errorMsg.match(/warning/g) || []).length;

                  if (!params.json) {
                    log.cli("⚠️  Pre-commit linting detected issues during task status commit");
                    log.cli("📝 Task status was updated but commit had linting issues");

                    if (errorCount > 0) {
                      log.cli(`📋 Found ${errorCount} linting errors`);
                    }
                    if (warningCount > 0) {
                      log.cli(`📋 Found ${warningCount} linting warnings`);
                    }

                    log.cli("");
                    log.cli("💡 To fix issues:");
                    log.cli("  • Run 'bun run lint' to see detailed errors");
                    log.cli("  • Run 'bun run lint:fix' to auto-fix what's possible");
                    log.cli("");
                    log.cli(
                      "✅ The task is marked as DONE - you can fix linting issues separately"
                    );
                  }
                  // Log the warning without JSON metadata for cleaner output
                  log.warn("Task status commit failed due to pre-commit checks");
                  // Re-throw to fail the command - linting issues should block session approval
                  throw new MinskyError(
                    `Session approval failed due to linting issues (${errorCount} errors, ${warningCount} warnings)`
                  );
                } else {
                  // Re-throw for other types of commit errors
                  throw commitError;
                }
              }

              // Try to push the commit if it succeeded
              try {
                await deps.gitService.execInRepository(workingDirectory, "git push");
                log.debug(`Pushed task ${taskId} status update`);
              } catch (pushError) {
                // Log but don't fail if push fails
                log.warn("Failed to push task status commit", {
                  taskId,
                  error: getErrorMessage(pushError),
                });
              }
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

    // Restore stashed changes if we stashed them (non-GitHub only)
    if (hasStashedChanges && !params.noStash && sessionRecord.backendType !== "github") {
      try {
        if (!params.json) {
          log.cli("📦 Restoring stashed changes...");
        }
        log.debug("Restoring stashed changes", { workdir: workingDirectory });

        const restoreResult = await deps.gitService.popStash(workingDirectory);
        if (restoreResult.stashed && !params.json) {
          log.cli("✅ Stashed changes restored successfully");
        }
        log.debug("Stashed changes restored", { restored: restoreResult.stashed });
      } catch (error) {
        log.warn("Failed to restore stashed changes", {
          error: getErrorMessage(error),
          workdir: workingDirectory,
        });
        if (!params.json) {
          log.cli(
            "⚠️  Warning: Failed to restore stashed changes. You may need to manually run 'git stash pop'"
          );
        }
        // Don't fail the entire operation if stash restoration fails
      }
    }

    // Clean up local branches after successful merge
    if (isNewlyApproved) {
      try {
        await cleanupLocalBranches(
          deps.gitService,
          workingDirectory,
          prBranch,
          sessionNameToUse,
          taskId
        );
        log.debug("Successfully cleaned up local branches after merge");
      } catch (cleanupError) {
        // Log but don't fail the operation if cleanup fails
        log.debug(`Branch cleanup failed (non-critical): ${getErrorMessage(cleanupError)}`);
      }
    }

    return mergeInfo;
  } catch (error) {
    // If there's an error during approval, try to restore stashed changes
    if (hasStashedChanges && !params.noStash) {
      try {
        log.debug("Restoring stashed changes after error", { workdir: workingDirectory });
        await deps.gitService.popStash(workingDirectory);
        log.debug("Restored stashed changes after error");
        if (!params.json) {
          log.cli("📦 Restored stashed changes after error");
        }
      } catch (stashError) {
        log.warn("Failed to restore stashed changes after error", {
          stashError: getErrorMessage(stashError),
        });
        if (!params.json) {
          log.cli(
            "⚠️  Warning: Failed to restore stashed changes after error. You may need to manually run 'git stash pop'"
          );
        }
      }
    }

    if (error instanceof MinskyError) {
      throw error;
    } else {
      throw new MinskyError(`Failed to approve session: ${getErrorMessage(error)}`);
    }
  }
}

/**
 * Clean up local branches after successful merge
 * Handles failures gracefully to not break the overall approval process
 */
export async function cleanupLocalBranches(
  gitService: GitServiceInterface,
  workingDirectory: string,
  prBranch: string,
  sessionName: string,
  taskId?: string
): Promise<void> {
  // Clean up the PR branch (e.g., pr/task#265)
  try {
    await gitService.execInRepository(workingDirectory, `git branch -d ${prBranch}`);
    log.debug(`Successfully deleted local PR branch: ${prBranch}`);
  } catch (error) {
    // Check if it's because branch is not fully merged
    const errorMessage = getErrorMessage(error);
    if (errorMessage.includes("not fully merged")) {
      // Try force delete
      try {
        await gitService.execInRepository(workingDirectory, `git branch -D ${prBranch}`);
        log.debug(`Successfully force-deleted local PR branch: ${prBranch}`);
      } catch (forceError) {
        log.debug(
          `Failed to force-delete local PR branch ${prBranch}: ${getErrorMessage(forceError)}`
        );
      }
    } else {
      log.debug(`Failed to delete local PR branch ${prBranch}: ${errorMessage}`);
    }
  }

  // For task branches, be smarter about which ones to try
  // First, check what branches actually exist locally
  try {
    const allBranchesOutput = await gitService.execInRepository(
      workingDirectory,
      'git branch --format="%(refname:short)"'
    );
    const existingBranches: string[] = allBranchesOutput
      .split("\n")
      .map((b) => b.trim())
      .filter((b) => b && b !== prBranch);

    // Extract task ID from session name if not provided and session follows task# pattern
    const taskBranchName = taskId ? taskId.replace("#", "") : sessionName.replace("task#", "");

    // Build list of possible task branch names
    const possibleTaskBranches: string[] = [];

    // Add sessionName if it looks like a task branch and exists
    if (sessionName && sessionName !== prBranch && existingBranches.includes(sessionName)) {
      possibleTaskBranches.push(sessionName);
    }

    // Add numeric version if it exists
    if (
      taskBranchName &&
      taskBranchName !== sessionName &&
      existingBranches.includes(taskBranchName)
    ) {
      possibleTaskBranches.push(taskBranchName);
    }

    // Add task prefix versions if they exist
    if (taskBranchName) {
      const taskVariants: string[] = [`task${taskBranchName}`, `task#${taskBranchName}`];
      for (const variant of taskVariants) {
        if (variant !== sessionName && existingBranches.includes(variant)) {
          possibleTaskBranches.push(variant);
        }
      }
    }

    // Only try to delete branches that actually exist
    for (const branch of possibleTaskBranches) {
      try {
        await gitService.execInRepository(workingDirectory, `git branch -d ${branch}`);
        log.debug(`Successfully deleted local task branch: ${branch}`);
        break; // Stop after first successful deletion
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        if (errorMessage.includes("not fully merged")) {
          // Try force delete
          try {
            await gitService.execInRepository(workingDirectory, `git branch -D ${branch}`);
            log.debug(`Successfully force-deleted local task branch: ${branch}`);
            break; // Stop after successful force deletion
          } catch (forceError) {
            log.debug(
              `Failed to force-delete local task branch ${branch}: ${getErrorMessage(forceError)}`
            );
          }
        } else {
          log.debug(`Failed to delete local task branch ${branch}: ${errorMessage}`);
        }
      }
    }
  } catch (listError) {
    // If we can't list branches, fall back to trying common patterns (but only warn, don't error)
    log.debug(`Could not list local branches for cleanup: ${getErrorMessage(listError)}`);
  }
}

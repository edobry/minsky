import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
} from "../../errors/index";
import { taskIdSchema as TaskIdSchema } from "../../schemas/common";
import { log } from "../../utils/logger";
import { type GitServiceInterface } from "../git";
import { createGitService } from "../git";
import { TASK_STATUS, createConfiguredTaskService } from "../tasks";
import type { Task } from "../tasks/types";
import { execAsync } from "../../utils/exec";
import { type WorkspaceUtilsInterface, getCurrentSession } from "../workspace";
import * as WorkspaceUtils from "../workspace";
import type { SessionProviderInterface } from "../session";
import type { SessionRecord } from "../session";
import { updatePrStateOnMerge } from "./session-update-operations";
import { assertSessionMutable } from "./session-mutability";
import {
  createRepositoryBackend,
  RepositoryBackendType,
  type RepositoryBackend,
  type RepositoryBackendConfig,
} from "../repository/index";
import type { PersistenceProvider } from "../persistence/types";

/**
 * Create repository backend from session record's stored configuration.
 * Only GitHub is supported; all sessions use the GitHub backend.
 */
async function createRepositoryBackendFromSession(
  sessionRecord: SessionRecord,
  sessionDB: SessionProviderInterface
): Promise<RepositoryBackend> {
  const config: RepositoryBackendConfig = {
    type: RepositoryBackendType.GITHUB,
    repoUrl: sessionRecord.repoUrl,
  };

  return await createRepositoryBackend(config, sessionDB);
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
  depsInput: {
    sessionDB: SessionProviderInterface;
    gitService?: GitServiceInterface;
    taskService?: {
      setTaskStatus?: (taskId: string, status: string) => Promise<void>;
      getTaskStatus?: (taskId: string) => Promise<string | undefined>;
      getBackendForTask?: (taskId: string) => Promise<string>;
      getTask?: (taskId: string) => Promise<Task | null>;
    };
    workspaceUtils?: WorkspaceUtilsInterface;
    getCurrentSession?: (repoPath: string) => Promise<string | null>;
    createRepositoryBackend?: (sessionRecord: SessionRecord) => Promise<RepositoryBackend>;
    persistenceProvider?: PersistenceProvider;
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

  let sessionIdToUse = params.session;
  let taskId: string | undefined;

  const sessionDB = depsInput.sessionDB;

  // Try to get session from task ID if provided
  if (params.task && !sessionIdToUse) {
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
          persistenceProvider: (() => {
            if (!depsInput.persistenceProvider) {
              throw new Error("persistenceProvider is required in session approve deps");
            }
            return depsInput.persistenceProvider;
          })(),
        });

    try {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const task = await taskService.getTask!(taskIdToUse);
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
    sessionIdToUse = session.session;
  }

  // Try to auto-detect session from repo path if no session ID or task is provided
  if (!sessionIdToUse && params.repo) {
    if (!params.json) {
      log.cli("🔍 Auto-detecting session from repository...");
    }

    const getCurrentSessionFunc =
      depsInput.getCurrentSession ||
      (async (p: string) => (await getCurrentSession(p, execAsync, sessionDB)) ?? null);
    const detectedSession = await getCurrentSessionFunc(params.repo);
    if (detectedSession) {
      sessionIdToUse = detectedSession;
    }
  }

  // Validate that we have a session to work with
  if (!sessionIdToUse) {
    throw new ValidationError("No session detected. Please provide a session ID or task ID");
  }

  // Get the session record
  const sessionRecord = await sessionDB.getSession(sessionIdToUse);
  if (!sessionRecord) {
    throw new ResourceNotFoundError(
      `Session "${sessionIdToUse}" not found`,
      "session",
      sessionIdToUse
    );
  }

  // Enforce merged-PR-freeze invariant
  assertSessionMutable(sessionRecord, "approve a pull request");

  // BUG FIX: Use the original repo URL/path for task updates, not session workspace
  const originalRepoPath = params.repo || sessionRecord.repoUrl || process.cwd();

  // Set up default dependencies with the correct repo path
  const deps = {
    sessionDB,
    gitService: depsInput.gitService || createGitService(),
    taskService:
      depsInput.taskService ||
      (await createConfiguredTaskService({
        workspacePath: originalRepoPath,
        persistenceProvider: (() => {
          if (!depsInput.persistenceProvider) {
            throw new Error("persistenceProvider is required in session approve deps");
          }
          return depsInput.persistenceProvider;
        })(),
      })),
    workspaceUtils: depsInput.workspaceUtils || WorkspaceUtils,
    getCurrentSession: depsInput.getCurrentSession || getCurrentSession,
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
  const featureBranch = sessionRecord.branch || sessionIdToUse;
  const prBranch = `pr/${featureBranch}`;
  const baseBranch = "main"; // Default base branch, could be made configurable

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
      depsInput?.createRepositoryBackend ||
      ((record: SessionRecord) => createRepositoryBackendFromSession(record, depsInput.sessionDB));
    const repositoryBackend = await createBackendFn(sessionRecord);
    const backendType = repositoryBackend.getType();

    if (!params.json) {
      log.cli(`📦 Using ${backendType} repository backend for merge`);
    }

    // For GitHub backend, use session ID as PR identifier
    const prIdentifier: string | number = sessionIdToUse;

    if (!params.json) {
      log.cli(`🔀 Merging pull request using ${backendType} backend...`);
    }

    // Use repository backend to merge the pull request
    let mergeResult;
    try {
      mergeResult = await repositoryBackend.pr.merge(prIdentifier, sessionIdToUse);
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
      log.cli(`✅ GitHub PR merged successfully!`);
      log.cli(`📝 Commit: ${commitHash.substring(0, 8)}...`);
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
    await updatePrStateOnMerge(sessionIdToUse, deps.sessionDB);

    // Continue with existing cleanup and task status logic...

    // Create merge info
    const mergeInfo = {
      session: sessionIdToUse,
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
          // Do not perform git commits here; persistence is handled by the task backend
          if (!params.json) {
            log.cli("✅ Task status updated (handled by task backend)");
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

    // Clean up local branches after successful merge
    if (isNewlyApproved) {
      try {
        await cleanupLocalBranches(
          deps.gitService,
          workingDirectory,
          prBranch,
          sessionIdToUse,
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
  sessionId: string,
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

    // Extract task ID from session ID if not provided and session follows task# pattern
    const taskBranchName = taskId ? taskId.replace("#", "") : sessionId.replace("task#", "");

    // Build list of possible task branch names
    const possibleTaskBranches: string[] = [];

    // Add sessionId if it looks like a task branch and exists
    if (sessionId && sessionId !== prBranch && existingBranches.includes(sessionId)) {
      possibleTaskBranches.push(sessionId);
    }

    // Add numeric version if it exists
    if (
      taskBranchName &&
      taskBranchName !== sessionId &&
      existingBranches.includes(taskBranchName)
    ) {
      possibleTaskBranches.push(taskBranchName);
    }

    // Add task prefix versions if they exist
    if (taskBranchName) {
      const taskVariants: string[] = [`task${taskBranchName}`, `task#${taskBranchName}`];
      for (const variant of taskVariants) {
        if (variant !== sessionId && existingBranches.includes(variant)) {
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

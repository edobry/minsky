import { existsSync, rmSync } from "fs";
import { readFile, writeFile, mkdir, access, rename } from "fs/promises";
import { join } from "path";
import { getMinskyStateDir, getSessionDir } from "../utils/paths";
import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
  createCommandFailureMessage,
  createErrorContext,
} from "../errors/index";
import { taskIdSchema } from "../schemas/common";
import type {
  SessionListParams,
  SessionGetParams,
  SessionStartParams,
  SessionDeleteParams,
  SessionDirParams,
  SessionUpdateParams,
  SessionPrParams,
} from "../schemas/session";
import { log } from "../utils/logger";
import { installDependencies } from "../utils/package-manager";
import { type GitServiceInterface, preparePrFromParams } from "./git";
import { createGitService } from "./git";
import { ConflictDetectionService } from "./git/conflict-detection";
import { normalizeRepoName, resolveRepoPath } from "./repo-utils";
import { TaskService, TASK_STATUS, type TaskServiceInterface } from "./tasks";
import { execAsync } from "../utils/exec";
import { extractPrDescription } from "./session/session-update-operations";
import {
  type WorkspaceUtilsInterface,
  getCurrentSession,
  getCurrentSessionContext,
} from "./workspace";
import * as WorkspaceUtils from "./workspace";
import { SessionDbAdapter } from "./session/session-db-adapter";
import { createTaskFromDescription } from "./templates/session-templates";
import { resolveSessionContextWithFeedback } from "./session/session-context-resolver";
import { approveSessionImpl } from "./session/session-approve-operations";
import { sessionCommit } from "./session/session-commands";
import { execGitWithTimeout } from "../utils/git-exec";
import {
  getSessionImpl,
  listSessionsImpl,
  deleteSessionImpl,
  getSessionDirImpl,
  inspectSessionImpl,
} from "./session/session-lifecycle-operations";
import { startSessionImpl } from "./session/session-start-operations";
import { updateSessionImpl } from "./session/session-update-operations";
import { sessionPrImpl } from "./session/session-pr-operations";
import { sessionReviewImpl } from "./session/session-review-operations";

export interface SessionRecord {
  session: string;
  repoName: string;
  repoUrl: string;
  createdAt: string;
  taskId?: string;
  backendType?: "local" | "remote" | "github"; // Added for repository backend support
  github?: {
    owner?: string;
    repo?: string;
    token?: string;
  };
  remote?: {
    authMethod?: "ssh" | "https" | "token";
    depth?: number;
  };
  branch?: string; // Branch property is already part of the interface
  prState?: {
    branchName: string;
    exists: boolean;
    lastChecked: string; // ISO timestamp
    createdAt?: string; // When PR branch was created
    mergedAt?: string; // When merged (for cleanup)
  };
}

export interface Session {
  session: string;
  repoUrl?: string;
  repoName?: string;
  branch?: string;
  createdAt?: string;
  taskId?: string;
  backendType?: "local" | "remote" | "github";
  github?: {
    owner?: string;
    repo?: string;
    token?: string;
  };
  remote?: {
    authMethod?: "ssh" | "https" | "token";
    depth?: number;
  };
}

/**
 * Interface for session database operations
 * This defines the contract for session management functionality
 */
export interface SessionProviderInterface {
  /**
   * Get all available sessions
   */
  listSessions(): Promise<SessionRecord[]>;

  /**
   * Get a specific session by name
   */
  getSession(session: string): Promise<SessionRecord | null>;

  /**
   * Get a specific session by task ID
   */
  getSessionByTaskId(taskId: string): Promise<SessionRecord | null>;

  /**
   * Add a new session to the database
   */
  addSession(record: SessionRecord): Promise<void>;

  /**
   * Update an existing session
   */
  updateSession(session: string, updates: Partial<Omit<SessionRecord, "session">>): Promise<void>;

  /**
   * Delete a session by name
   */
  deleteSession(session: string): Promise<boolean>;

  /**
   * Get the repository path for a session
   */
  getRepoPath(record: SessionRecord | any): Promise<string>;

  /**
   * Get the working directory for a session
   */
  getSessionWorkdir(sessionName: string): Promise<string>;
}

/**
 * Gets session details based on parameters
 * Using proper dependency injection for better testability
 * Now includes auto-detection capabilities via unified session context resolver
 */
export async function getSessionFromParams(
  params: SessionGetParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
  }
): Promise<Session | null> {
  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
  };

  // Delegate to extracted implementation
  return getSessionImpl(params, deps);
}

/**
 * Lists all sessions based on parameters
 * Using proper dependency injection for better testability
 */
export async function listSessionsFromParams(
  params: SessionListParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
  }
): Promise<Session[]> {
  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
  };

  // Delegate to extracted implementation
  return listSessionsImpl(params, deps);
}

/**
 * Starts a new session based on parameters
 * Using proper dependency injection for better testability
 */
export async function startSessionFromParams(
  params: SessionStartParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitServiceInterface;
    taskService?: TaskServiceInterface;
    workspaceUtils?: WorkspaceUtilsInterface;
    resolveRepoPath?: typeof resolveRepoPath;
  }
): Promise<Session> {
  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    gitService: depsInput?.gitService || createGitService(),
    taskService:
      depsInput?.taskService ||
      new TaskService({
        workspacePath: process.cwd(),
        backend: "markdown",
      }),
    workspaceUtils: depsInput?.workspaceUtils || WorkspaceUtils.createWorkspaceUtils(),
    resolveRepoPath: depsInput?.resolveRepoPath || resolveRepoPath,
  };

  // Delegate to extracted implementation
  return startSessionImpl(params, deps);
}

/**
 * Deletes a session based on parameters
 * Using proper dependency injection for better testability
 */
export async function deleteSessionFromParams(
  params: SessionDeleteParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
  }
): Promise<boolean> {
  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
  };

  // Delegate to extracted implementation
  return deleteSessionImpl(params, deps);
}

/**
 * Gets session directory based on parameters
 * Using proper dependency injection for better testability
 */
export async function getSessionDirFromParams(
  params: SessionDirParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
  }
): Promise<string> {
  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
  };

  // Delegate to extracted implementation
  return getSessionDirImpl(params, deps);
}

/**
 * Interface-agnostic function for updating a session
 */
export async function updateSessionFromParams(
  params: SessionUpdateParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitServiceInterface;
    workspaceUtils?: WorkspaceUtilsInterface;
  }
): Promise<Session> {
  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    gitService: depsInput?.gitService || createGitService(),
    workspaceUtils: depsInput?.workspaceUtils || WorkspaceUtils.createWorkspaceUtils(),
    getCurrentSession: getCurrentSession,
  };

  // Delegate to extracted implementation
  return updateSessionImpl(params, deps);
}

/**
 * Helper function to check if a PR branch exists for a session
 */
export async function checkPrBranchExists(
  sessionName: string,
  gitService: GitServiceInterface,
  currentDir: string
): Promise<boolean> {
  const prBranch = `pr/${sessionName}`;

  try {
    // Check if branch exists locally
    const localBranchOutput = await gitService.execInRepository(
      currentDir,
      `git show-ref --verify --quiet refs/heads/${prBranch} || echo "not-exists"`
    );
    const localBranchExists = localBranchOutput.trim() !== "not-exists";

    if (localBranchExists) {
      return true;
    }

    // Check if branch exists remotely
    const remoteBranchOutput = await gitService.execInRepository(
      currentDir,
      `git ls-remote --heads origin ${prBranch}`
    );
    const remoteBranchExists = remoteBranchOutput.trim().length > 0;

    return remoteBranchExists;
  } catch (error) {
    log.debug("Error checking PR branch existence", {
      error: getErrorMessage(error),
      prBranch,
      sessionName,
    });
    return false;
  }
}

/**
 * Check if PR state cache is stale (older than 5 minutes)
 */
function isPrStateStale(prState: { lastChecked: string }): boolean {
  const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
  const lastChecked = new Date(prState.lastChecked).getTime();
  const now = Date.now();
  return now - lastChecked > STALE_THRESHOLD_MS;
}

/**
 * Optimized PR branch existence check using cached state
 */
export async function checkPrBranchExistsOptimized(
  sessionName: string,
  gitService: GitServiceInterface,
  currentDir: string,
  sessionDB: SessionProviderInterface
): Promise<boolean> {
  const sessionRecord = await sessionDB.getSession(sessionName);

  // If no session record, fall back to git operations
  if (!sessionRecord) {
    log.debug("No session record found, falling back to git operations", { sessionName });
    return checkPrBranchExists(sessionName, gitService, currentDir);
  }

  // Check if we have cached PR state and it's not stale
  if (sessionRecord.prState && !isPrStateStale(sessionRecord.prState)) {
    log.debug("Using cached PR state", {
      sessionName,
      exists: sessionRecord.prState.exists,
      lastChecked: sessionRecord.prState.lastChecked,
    });
    return sessionRecord.prState.exists;
  }

  // Cache is stale or missing, perform git operations and update cache
  log.debug("PR state cache is stale or missing, refreshing", {
    sessionName,
    hasState: !!sessionRecord.prState,
    isStale: sessionRecord.prState ? isPrStateStale(sessionRecord.prState) : false,
  });

  const exists = await checkPrBranchExists(sessionName, gitService, currentDir);

  // Update the session record with fresh PR state
  const prBranch = `pr/${sessionName}`;
  const updatedPrState = {
    branchName: prBranch,
    exists,
    lastChecked: new Date().toISOString(),
    createdAt: sessionRecord.prState?.createdAt || (exists ? new Date().toISOString() : undefined),
    mergedAt: sessionRecord.prState?.mergedAt,
  };

  await sessionDB.updateSession(sessionName, { prState: updatedPrState });

  log.debug("Updated PR state cache", {
    sessionName,
    exists,
    lastChecked: updatedPrState.lastChecked,
  });

  return exists;
}

/**
 * Update PR state when a PR branch is created
 */
export async function updatePrStateOnCreation(
  sessionName: string,
  sessionDB: SessionProviderInterface
): Promise<void> {
  const prBranch = `pr/${sessionName}`;
  const now = new Date().toISOString();

  const prState = {
    branchName: prBranch,
    exists: true,
    lastChecked: now,
    createdAt: now,
    mergedAt: undefined,
  };

  await sessionDB.updateSession(sessionName, { prState });

  log.debug("Updated PR state on creation", {
    sessionName,
    prBranch,
    createdAt: now,
  });
}

/**
 * Update PR state when a PR branch is merged
 */
export async function updatePrStateOnMerge(
  sessionName: string,
  sessionDB: SessionProviderInterface
): Promise<void> {
  const now = new Date().toISOString();

  const sessionRecord = await sessionDB.getSession(sessionName);
  if (!sessionRecord?.prState) {
    log.debug("No PR state found for session, cannot update merge state", { sessionName });
    return;
  }

  const updatedPrState = {
    ...sessionRecord.prState,
    exists: false,
    lastChecked: now,
    mergedAt: now,
  };

  await sessionDB.updateSession(sessionName, { prState: updatedPrState });

  log.debug("Updated PR state on merge", {
    sessionName,
    mergedAt: now,
  });
}

/**
 * Interface-agnostic function for creating a PR for a session
 */
export async function sessionPrFromParams(
  params: SessionPrParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitServiceInterface;
    taskService?: TaskServiceInterface;
    workspaceUtils?: WorkspaceUtilsInterface;
  }
): Promise<{
  prBranch: string;
  baseBranch: string;
  title?: string;
  body?: string;
}> {
  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    gitService: depsInput?.gitService || createGitService(),
    taskService:
      depsInput?.taskService ||
      new TaskService({
        workspacePath: process.cwd(),
        backend: "markdown",
      }),
    workspaceUtils: depsInput?.workspaceUtils || WorkspaceUtils.createWorkspaceUtils(),
  };

  // Delegate to extracted implementation
  return sessionPrImpl(params, deps);
}

/**
 * Approves and merges a session PR branch
 */
export async function approveSessionFromParams(
  params: {
    name?: string;
    task?: string;
    repo?: string;
    noStash?: boolean;
  },
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitServiceInterface;
    taskService?: TaskServiceInterface;
    workspaceUtils?: WorkspaceUtilsInterface;
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
  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    gitService: depsInput?.gitService || createGitService(),
    taskService:
      depsInput?.taskService ||
      new TaskService({
        workspacePath: process.cwd(),
        backend: "markdown",
      }),
    workspaceUtils: depsInput?.workspaceUtils || WorkspaceUtils.createWorkspaceUtils(),
  };

  // Delegate to extracted implementation
  return approveSessionImpl(params, deps);
}

/**
  if (params.task && !sessionNameToUse) {
    const taskIdToUse = taskIdSchema.parse(params.task);
    taskId = taskIdToUse;

    // Get session by task ID
    const session = await sessionDB.getSessionByTaskId(taskIdToUse);
    if (!session) {
      throw new ResourceNotFoundError(
        `🚫 No Session Found for Task ${taskIdToUse}

Task ${taskIdToUse} exists but has no associated session to approve.

💡 Here's what you can do:

1️⃣ Check if the task has a session:
   minsky session list

2️⃣ Start a session for this task:
   minsky session start --task ${taskIdToUse}

3️⃣ Or approve a different task that has a session:
   minsky session list | grep "task:"
   minsky session approve --task <task-id-with-session>

📋 Current available sessions:
   Run 'minsky session list' to see which tasks have active sessions.

❓ Need help?
   • Use 'minsky session start --task ${taskIdToUse}' to create a session
   • Use 'minsky tasks list' to see all available tasks
   • Use 'minsky session get --task <id>' to check session details`,
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
        } catch (branchError) {
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
    } catch (statusError) {
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
      const prBranchCommitHash = (
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
          // Check if remote branch exists first using timeout wrapper to avoid hanging
          // This is expected to fail if the branch doesn't exist, which is normal
          await execGitWithTimeout("check-remote-ref", `show-ref --verify --quiet refs/remotes/origin/${prBranch}`, {
            workdir: workingDirectory
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

              // Commit the task status update with conventional commits format
              try {
                await deps.gitService.execInRepository(workingDirectory, `git commit -m "chore(${taskId}): update task status to DONE"`);
                log.debug(`Committed task ${taskId} status update`);
              } catch (commitError) {
                                 // Handle pre-commit hook failures gracefully
                 const errorMsg = getErrorMessage(commitError as Error);
                 if (errorMsg.includes("pre-commit") || errorMsg.includes("lint")) {
                   // Parse linter output to show clean summary
                   const errorCount = (errorMsg.match(/error/g) || []).length;
                   const warningCount = (errorMsg.match(/warning/g) || []).length;

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

                   log.warn("Task status commit failed due to pre-commit checks", {
                     taskId,
                     errors: errorCount,
                     warnings: warningCount,
                   });
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
    (branch) => branch && branch !== prBranch && !branch.startsWith("#") && branch !== ""
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

/**
 * Creates a default SessionProvider implementation
 * This factory function provides a consistent way to get a session provider with optional customization
 */
export function createSessionProvider(options?: {
  dbPath?: string;
  useNewBackend?: boolean;
}): SessionProviderInterface {
  // Always use the new configuration-based backend
  return new SessionDbAdapter();
}

/**
 * Inspects current session based on workspace location
 */
export async function inspectSessionFromParams(params: {
  task?: string;
  repo?: string;
  name?: string;
}): Promise<{
  session: {
    name: string;
    path: string;
    branch: string;
    repoUrl: string;
    taskId?: string;
  };
  workspace: {
    isSessionWorkspace: boolean;
    currentDirectory: string;
  };
}> {
  // Set up dependencies with defaults
  const deps = {
    sessionDB: createSessionProvider(),
  };

  // Delegate to extracted implementation
  return inspectSessionImpl(params, deps);
}

/**
 * Interface for session review parameters
 */
export interface SessionReviewParams {
  session?: string;
  task?: string;
  repo?: string;
  output?: string;
  json?: boolean;
  prBranch?: string;
}

/**
 * Interface for session review result
 */
export interface SessionReviewResult {
  session: string;
  taskId?: string;
  taskSpec?: string;
  prDescription?: string;
  prBranch: string;
  baseBranch: string;
  diff?: string;
  diffStats?: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
}

/**
 * Reviews a session PR by gathering and displaying relevant information
 */
export async function sessionReviewFromParams(
  params: {
    name?: string;
    task?: string;
    repo?: string;
  },
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitServiceInterface;
    taskService?: TaskServiceInterface;
  }
): Promise<{
  session: {
    name: string;
    taskId?: string;
    branch: string;
    repoUrl: string;
  };
  prDetails: {
    title: string;
    body: string;
    sourceBranch: string;
    targetBranch: string;
    branchExists: boolean;
  };
  taskSpec?: {
    title: string;
    description: string;
  };
  changes: {
    totalCommits: number;
    changedFiles: string[];
    diffSummary: string;
  };
}> {
  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    gitService: depsInput?.gitService || createGitService(),
    taskService:
      depsInput?.taskService ||
      new TaskService({
        workspacePath: process.cwd(),
        backend: "markdown",
      }),
  };

  // Delegate to extracted implementation
  return sessionReviewImpl(params, deps);
}

// Re-export types from session-db module for convenience
export type { SessionRecord, SessionDbState } from "./session/session-db";

// Re-export the SessionDbAdapter class
export { SessionDbAdapter } from "./session/session-db-adapter";

// Export SessionDB as function for backward compatibility with existing imports
// This replaces the old class-based compatibility layer with a cleaner function-based approach
export const SessionDB = createSessionProvider;

// Re-export session command functions with shorter names for adapters
export { listSessionsFromParams as sessionList };
export { getSessionFromParams as sessionGet };
export { startSessionFromParams as sessionStart };
export { deleteSessionFromParams as sessionDelete };
export { getSessionDirFromParams as sessionDir };
export { updateSessionFromParams as sessionUpdate };
export { approveSessionFromParams as sessionApprove };
export { sessionPrFromParams as sessionPr };
export { inspectSessionFromParams as sessionInspect };

// Export new session-scoped git commands
export { sessionCommit };

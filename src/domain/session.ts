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
import { createSessionProvider } from "./session/session-db-adapter";
import {
  resolveRepositoryAndBackend,
  detectRepositoryBackendTypeFromUrl,
} from "./session/repository-backend-detection";
import { TASK_STATUS, type TaskServiceInterface } from "./tasks";
import { createConfiguredTaskService } from "./tasks/taskService";
import { taskIdToSessionName } from "./tasks/task-id";

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
import { approveSessionPr } from "./session/session-approval-operations";
import { sessionCommit } from "./session/session-commands";
import { execGitWithTimeout } from "../utils/git-exec";
import type { SessionRecord } from "./session/session-db";

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
  const { name, task, repo } = params;

  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || (await createSessionProvider()),
  };

  try {
    // Use unified session context resolver with auto-detection support
    const resolvedContext = await resolveSessionContextWithFeedback({
      session: name,
      task: task,
      repo: repo,
      sessionProvider: deps.sessionDB,
      allowAutoDetection: true,
    });

    // Get the session details using the resolved session name
    return deps.sessionDB.getSession(resolvedContext.sessionName);
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
    sessionDB: depsInput?.sessionDB || (await createSessionProvider()),
  };

  return deps.sessionDB.listSessions();
}

/**
 * Starts a new session based on parameters
 * Using proper dependency injection for better testability
 */
import { startSessionImpl } from "./session/start-session-operations";

export async function startSessionFromParams(
  params: SessionStartParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitServiceInterface;
    taskService?: TaskServiceInterface;
    workspaceUtils?: WorkspaceUtilsInterface;
    resolveRepositoryAndBackend?: typeof resolveRepositoryAndBackend;
    // Back-compat for older tests/consumers
    resolveRepoPath?: typeof resolveRepositoryAndBackend;
    // Optional filesystem adapter passthrough for tests
    fs?: {
      exists: (path: string) => boolean | Promise<boolean>;
      rm: (path: string, options: { recursive: boolean; force: boolean }) => Promise<void>;
    };
  }
): Promise<Session> {
  const deps = {
    sessionDB: depsInput?.sessionDB || (await createSessionProvider()),
    gitService: depsInput?.gitService || createGitService(),
    taskService:
      depsInput?.taskService ||
      (await createConfiguredTaskService({ workspacePath: process.cwd() })),
    workspaceUtils: depsInput?.workspaceUtils || WorkspaceUtils.createWorkspaceUtils(),
    resolveRepositoryAndBackend:
      depsInput?.resolveRepositoryAndBackend ||
      // Back-compat: wrap legacy resolveRepoPath(uri) => string into the new resolver interface
      (depsInput?.resolveRepoPath
        ? async (options?: { repoParam?: string; cwd?: string }) => {
            const uri = await (depsInput.resolveRepoPath as any)(
              options?.repoParam || options?.cwd
            );
            const backendType = detectRepositoryBackendTypeFromUrl(uri);
            return { repoUrl: uri, backendType };
          }
        : resolveRepositoryAndBackend),
    fs: depsInput?.fs,
  } as const;

  // Map to proper types expected by startSessionImpl
  const sessionStartParams = {
    name: params.name, // Can be undefined, will be auto-generated
    task: params.task,
    description: params.description || "", // Support auto-task creation
    branch: params.branch, // Use provided branch or let it default to session name
    packageManager: params.packageManager || "bun", // Default package manager
    skipInstall: params.skipInstall || false,
    noStatusUpdate: params.noStatusUpdate || false,
    quiet: params.quiet || false,
    repo: params.repo, // Repository path
    debug: false,
    format: "text" as const,
    force: false,
  };

  return startSessionImpl(sessionStartParams as any, deps);
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
  const { name, task, repo } = params;

  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || (await createSessionProvider()),
  };

  try {
    // Use unified session context resolver with auto-detection support
    const resolvedContext = await resolveSessionContextWithFeedback({
      session: name,
      task: task,
      repo: repo,
      sessionProvider: deps.sessionDB,
      allowAutoDetection: true,
    });

    // Delete the session using the resolved session name
    return deps.sessionDB.deleteSession(resolvedContext.sessionName);
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
  const deps = {
    sessionDB: depsInput?.sessionDB || (await createSessionProvider()),
  };

  let sessionName: string;

  if (params.task && !params.name) {
    // Find session by task ID
    const normalizedTaskId = taskIdSchema.parse(params.task);
    const session = await deps.sessionDB.getSessionByTaskId(normalizedTaskId);

    if (!session) {
      // Provide a more helpful error message showing possible sessions
      const allSessions = await deps.sessionDB.listSessions();
      const sessionNames = allSessions
        .map((s) => `${s.session}${s.taskId ? ` (Task #${s.taskId})` : ""}`)
        .join(", ");

      throw new ResourceNotFoundError(
        `No session found for task ID "${normalizedTaskId}"\n\n` +
          `💡 Available sessions: ${sessionNames}`
      );
    }

    sessionName = session.session;
  } else if (params.name) {
    sessionName = params.name;
  } else {
    throw new ResourceNotFoundError(`🚫 Session Directory: Missing Required Parameter

You must provide either a session name or task ID to get the session directory.

📖 Usage Examples:

  # Get directory by session name
  minsky session dir <session-name>

  # Get directory by task ID
  minsky session dir --task <task-id>
  minsky session dir -t <task-id>

💡 Tips:
  • List available sessions: minsky session list
  • Get session by task ID: minsky session get --task <task-id>
  • Check current session: minsky session inspect`);
  }

  const session = await deps.sessionDB.getSession(sessionName);

  if (!session) {
    // Provide a more helpful error message with available sessions
    const allSessions = await deps.sessionDB.listSessions();
    const sessionNames = allSessions
      .map((s) => `${s.session}${s.taskId ? ` (Task #${s.taskId})` : ""}`)
      .join(", ");

    throw new ResourceNotFoundError(
      `Session "${sessionName}" not found\n\n` + `💡 Available sessions: ${sessionNames}`
    );
  }

  // Get repo path from session using the getRepoPath method which has fallback logic
  const repoPath = await deps.sessionDB.getRepoPath(session);

  return repoPath;
}

/**
 * Interface-agnostic function for updating a session
 */
export async function updateSessionFromParams(
  params: SessionUpdateParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitServiceInterface;
    getCurrentSession?: typeof getCurrentSession;
  }
): Promise<Session> {
  let {
    name,
    branch,
    remote,
    noStash,
    noPush,
    force,
    skipConflictCheck,
    autoResolveDeleteConflicts,
    dryRun,
    skipIfAlreadyMerged,
  } = params;

  log.debug("updateSessionFromParams called", { params });

  // Set up dependencies with defaults
  const deps = {
    gitService: depsInput?.gitService || createGitService(),
    sessionDB: depsInput?.sessionDB || (await createSessionProvider()),
    getCurrentSession: depsInput?.getCurrentSession || getCurrentSession,
  };

  // Use unified session context resolver for consistent auto-detection
  let sessionName: string;
  try {
    const resolvedContext = await resolveSessionContextWithFeedback({
      session: name,
      task: params.task,
      repo: params.repo,
      sessionProvider: deps.sessionDB,
      allowAutoDetection: !name, // Only allow auto-detection if no name provided
    });
    sessionName = resolvedContext.sessionName;
    log.debug("Session resolved", { sessionName, resolvedBy: resolvedContext.resolvedBy });
  } catch (error) {
    log.debug("Failed to resolve session", { error, name, task: params.task });
    if (error instanceof ValidationError) {
      throw new ValidationError(
        "Session name is required. Either provide a session name (--name), task ID (--task), or run this command from within a session workspace."
      );
    }
    throw error;
  }

  log.debug("Dependencies set up", {
    hasGitService: !!deps.gitService,
    hasSessionDB: !!deps.sessionDB,
  });

  log.debug("Session update requested", {
    sessionName,
    branch,
    remote,
    noStash,
    noPush,
    force,
  });

  try {
    // Get session record
    log.debug("Getting session record", { name: sessionName });
    let sessionRecord = await deps.sessionDB.getSession(sessionName);

    // TASK #168 FIX: Self-repair logic for orphaned sessions
    if (!sessionRecord && sessionName) {
      log.debug("Session not found in database, attempting self-repair", { sessionName });
      const currentDir = process.cwd();

      // Check if we're in a session workspace
      if (currentDir.includes("/sessions/") && currentDir.includes(sessionName)) {
        log.debug("Detected orphaned session workspace, attempting to register", {
          sessionName,
          currentDir,
        });

        try {
          // Get repository URL from git remote
          const remoteOutput = await deps.gitService.execInRepository(
            currentDir,
            "git remote get-url origin"
          );
          const repoUrl = remoteOutput.trim();

          // Extract repo name from URL or path
          const repoName = repoUrl.includes("/")
            ? repoUrl.split("/").pop()?.replace(".git", "") || "unknown"
            : "local-minsky";

          // Extract task ID from session name - simpler and more reliable approach
          const taskId = sessionName.startsWith("task#") ? sessionName : undefined;

          // Create session record
          const newSessionRecord: SessionRecord = {
            session: sessionName,
            repoName,
            repoUrl,
            createdAt: new Date().toISOString(),
            taskId,
            branch: sessionName,
          };

          await deps.sessionDB.addSession(newSessionRecord);
          sessionRecord = newSessionRecord;

          log.cli(`🔧 Self-repair: Registered orphaned session '${sessionName}' in database`);
        } catch (repairError) {
          log.warn("Failed to self-repair orphaned session", {
            sessionName,
            error: repairError instanceof Error ? repairError.message : String(repairError),
          });
        }
      }
    }

    if (!sessionRecord) {
      throw new ResourceNotFoundError(`Session '${sessionName}' not found`, "session", sessionName);
    }

    log.debug("Session record found", { sessionRecord });

    // Get session workdir
    const workdir = await deps.sessionDB.getSessionWorkdir(sessionName);
    log.debug("Session workdir resolved", { workdir });

    // Get current branch
    const currentBranch = await deps.gitService.getCurrentBranch(workdir);
    log.debug("Current branch", { currentBranch });

    // Validate current state if not forced
    if (!force) {
      const hasUncommittedChanges = await deps.gitService.hasUncommittedChanges(workdir);
      if (hasUncommittedChanges && !noStash) {
        log.debug("Stashing uncommitted changes", { workdir });
        await deps.gitService.stashChanges(workdir);
        log.debug("Changes stashed");
      }
    }

    try {
      // Pull latest changes
      log.debug("Pulling latest changes", { workdir, remote: remote || "origin" });
      await deps.gitService.fetchLatest!(workdir, remote || "origin");
      log.debug("Latest changes pulled");

      // Determine target branch for merge - use actual default branch from repo instead of hardcoding "main"
      const branchToMerge = branch || (await deps.gitService.fetchDefaultBranch(workdir));
      const remoteBranchToMerge = `${remote || "origin"}/${branchToMerge}`;

      // Enhanced conflict detection and smart merge handling
      if (dryRun) {
        log.cli("🔍 Performing dry run conflict check...");

        const conflictPrediction = await ConflictDetectionService.predictConflicts(
          workdir,
          currentBranch,
          remoteBranchToMerge
        );

        if (conflictPrediction.hasConflicts) {
          log.cli("⚠️  Conflicts detected during dry run:");
          log.cli(conflictPrediction.userGuidance);
          log.cli("\n🛠️  Recovery commands:");
          conflictPrediction.recoveryCommands.forEach((cmd) => log.cli(`   ${cmd}`));

          throw new MinskyError(
            "Dry run detected conflicts. Use the guidance above to resolve them."
          );
        } else {
          log.cli("✅ No conflicts detected. Safe to proceed with update.");
          return {
            session: sessionName,
            repoName: sessionRecord.repoName || "unknown",
            repoUrl: sessionRecord.repoUrl,
            branch: currentBranch,
            createdAt: sessionRecord.createdAt,
            taskId: sessionRecord.taskId,
          };
        }
      }

      // Fix for origin/origin/main bug: Pass base branch name without origin/ prefix
      // ConflictDetectionService expects plain branch names and adds origin/ internally
      const normalizedBaseBranch = branchToMerge;

      // Use smart session update for enhanced conflict handling (only if not forced)
      if (!force) {
        const updateResult = await ConflictDetectionService.smartSessionUpdate(
          workdir,
          currentBranch,
          normalizedBaseBranch,
          {
            skipIfAlreadyMerged,
            autoResolveConflicts: autoResolveDeleteConflicts,
          }
        );

        if (!updateResult.updated && updateResult.skipped) {
          log.cli(`✅ ${updateResult.reason}`);

          if (updateResult.reason?.includes("already in base")) {
            log.cli(
              "\n💡 Your session changes are already merged. You can create a PR with --skip-update:"
            );
            log.cli('   minsky session pr --title "Your PR title" --skip-update');
          }

          return {
            session: sessionName,
            repoName: sessionRecord.repoName || "unknown",
            repoUrl: sessionRecord.repoUrl,
            branch: currentBranch,
            createdAt: sessionRecord.createdAt,
            taskId: sessionRecord.taskId,
          };
        }

        if (!updateResult.updated && updateResult.conflictDetails) {
          // Enhanced conflict guidance
          log.cli("🚫 Update failed due to merge conflicts:");
          log.cli(updateResult.conflictDetails);

          if (updateResult.divergenceAnalysis) {
            const analysis = updateResult.divergenceAnalysis;
            log.cli("\n📊 Branch Analysis:");
            log.cli(`   • Session ahead: ${analysis.aheadCommits} commits`);
            log.cli(`   • Session behind: ${analysis.behindCommits} commits`);
            log.cli(`   • Recommended action: ${analysis.recommendedAction}`);

            if (analysis.sessionChangesInBase) {
              log.cli(`\n💡 Your changes appear to already be in ${branchToMerge}. Try:`);
              log.cli('   minsky session pr --title "Your PR title" --skip-update');
            }
          }

          throw new MinskyError(updateResult.conflictDetails);
        }

        log.debug("Enhanced merge completed successfully", { updateResult });
      } else {
        log.debug("Skipping conflict detection due to force flag", { force });
        // When forced, perform a simple merge without conflict detection
        try {
          await deps.gitService.mergeBranch(workdir, normalizedBaseBranch);
          log.debug("Forced merge completed");
        } catch (mergeError) {
          log.debug("Forced merge failed, but continuing due to force flag", {
            error: getErrorMessage(mergeError),
          });
        }
      }

      // Push changes if needed
      if (!noPush) {
        log.debug("Pushing changes to remote", { workdir, remote: remote || "origin" });
        await deps.gitService.push({
          repoPath: workdir,
          remote: remote || "origin",
        });
        log.debug("Changes pushed to remote");
      }

      // Restore stashed changes if we stashed them
      if (!noStash) {
        try {
          log.debug("Restoring stashed changes", { workdir });
          await deps.gitService.popStash(workdir);
          log.debug("Stashed changes restored");
        } catch (error) {
          log.warn("Failed to restore stashed changes", {
            error: getErrorMessage(error),
            workdir,
          });
          // Don't fail the entire operation if stash pop fails
        }
      }

      log.cli(`Session '${sessionName}' updated successfully`);

      return {
        session: sessionName,
        repoName: sessionRecord.repoName || "unknown",
        repoUrl: sessionRecord.repoUrl,
        branch: currentBranch,
        createdAt: sessionRecord.createdAt,
        taskId: sessionRecord.taskId,
      };
    } catch (error) {
      // If there's an error during update, try to clean up any stashed changes
      if (!noStash) {
        try {
          await deps.gitService.popStash(workdir);
          log.debug("Restored stashed changes after error");
        } catch (stashError) {
          log.warn("Failed to restore stashed changes after error", {
            stashError: getErrorMessage(stashError),
          });
        }
      }
      throw error;
    }
  } catch (error) {
    log.error("Session update failed", {
      error: getErrorMessage(error),
      name: sessionName,
    });
    if (error instanceof MinskyError) {
      throw error;
    } else {
      throw new MinskyError(`Failed to update session: ${getErrorMessage(error)}`, error);
    }
  }
}

// PR state cache functions — delegated to session-update-operations sub-module
export {
  checkPrBranchExists,
  checkPrBranchExistsOptimized,
  updatePrStateOnCreation,
  updatePrStateOnMerge,
} from "./session/session-update-operations";

/**
 * ❌ DEPRECATED: sessionPrFromParams() - legacy implementation
 * Use sessionPrImpl() from session-pr-operations.ts via pr-command.ts adapter instead.
 */
export async function sessionPrFromParams(
  params: SessionPrParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitServiceInterface;
  }
): Promise<{
  prBranch: string;
  baseBranch: string;
  title?: string;
  body?: string;
}> {
  throw new Error(
    "❌ DEPRECATED: sessionPrFromParams() has been removed. Use sessionPr() from './session/commands/pr-command.ts' instead."
  );
}

/**
 * ⚠️  SECURITY UPDATE (Task #358): Approves a session PR branch (DOES NOT MERGE)
 *
 * This function now only performs approval. Use 'session merge' separately to merge.
 * This prevents unauthorized merges and ensures proper code review workflow.
 */
export async function approveSessionFromParams(
  params: {
    session?: string;
    task?: string;
    repo?: string;
    json?: boolean;
    reviewComment?: string;
  },
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitServiceInterface;
    taskService?: TaskServiceInterface;
    workspaceUtils?: WorkspaceUtilsInterface;
    resolveRepoPath?: typeof resolveRepoPath;
    createRepositoryBackendForSession?: (workingDirectory: string) => Promise<any>;
    createRepositoryBackend?: (sessionRecord: any) => Promise<any>;
    getCurrentSession?: (repoPath: string) => Promise<string | null>;
  }
): Promise<{
  sessionName: string;
  taskId?: string;
  prBranch?: string;
  approvalInfo: {
    reviewId: number | string;
    approvedBy: string;
    approvedAt: string;
    prNumber: string | number;
    [key: string]: any;
  };
  wasAlreadyApproved: boolean;
}> {
  let sessionToUse = params.session;

  // Handle session detection from repo path (CLI interface concern)
  if (!sessionToUse && !params.task && params.repo) {
    const getCurrentSessionFunc = depsInput?.getCurrentSession || getCurrentSession;
    const detectedSession = await getCurrentSessionFunc(params.repo);
    if (detectedSession) {
      sessionToUse = detectedSession;
    }
  }

  // SECURITY: Use new approve-only operation
  const result = await approveSessionPr(
    {
      session: sessionToUse,
      task: params.task,
      repo: params.repo,
      json: params.json,
      reviewComment: params.reviewComment,
    },
    depsInput as any
  );

  // Transform the result to match the expected interface
  return {
    sessionName: result.session,
    taskId: result.taskId,
    prBranch: result.prBranch,
    approvalInfo: result.approvalInfo,
    wasAlreadyApproved: result.wasAlreadyApproved,
  };
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
  const possibleTaskBranches: string[] = [];

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
// Re-export createSessionProvider from session-db-adapter for backward compatibility
export { createSessionProvider } from "./session/session-db-adapter";

/**
 * Inspects current session based on workspace location
 */
export async function inspectSessionFromParams(params: {
  json?: boolean;
}): Promise<Session | null> {
  // Auto-detect the current session from the workspace
  const context = await getCurrentSessionContext(process.cwd());

  if (!context?.sessionId) {
    throw new ResourceNotFoundError("No session detected for the current workspace");
  }

  const sessionProvider = await createSessionProvider();
  const session = await sessionProvider.getSession(context.sessionId);

  return session;
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
  /** Warnings from data-gathering steps that failed non-fatally */
  warnings?: string[];
}

/**
 * Reviews a session PR by gathering and displaying relevant information
 */
export async function sessionReviewFromParams(
  params: SessionReviewParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
    gitService?: GitServiceInterface;
    taskService?: TaskServiceInterface & {
      getTaskSpecData?: (taskId: string) => Promise<string>;
    };
    workspaceUtils?: WorkspaceUtilsInterface;
    getCurrentSession?: typeof getCurrentSession;
  }
): Promise<SessionReviewResult> {
  // Set up default dependencies if not provided
  const deps = {
    sessionDB: depsInput?.sessionDB || (await createSessionProvider()),
    gitService: depsInput?.gitService || createGitService(),
    taskService:
      depsInput?.taskService ||
      (await createConfiguredTaskService({
        workspacePath: params.repo || process.cwd(),
      })),
    workspaceUtils: depsInput?.workspaceUtils || WorkspaceUtils,
    getCurrentSession: depsInput?.getCurrentSession || getCurrentSession,
  };

  let sessionNameToUse = params.session;
  let taskId: string | undefined;

  // Try to get session from task ID if provided
  if (params.task && !sessionNameToUse) {
    const taskIdToUse = taskIdSchema.parse(params.task);
    taskId = taskIdToUse;

    // Get session by task ID
    const session = await deps.sessionDB.getSessionByTaskId(taskIdToUse);
    if (!session) {
      throw new ResourceNotFoundError(
        `No session found for task ${taskIdToUse}`,
        "task",
        taskIdToUse
      );
    }
    sessionNameToUse = session.session;
  }

  // If session is still not set, try to detect it from repo path
  if (!sessionNameToUse && params.repo) {
    try {
      const sessionContext = await deps.getCurrentSession(params.repo);
      if (sessionContext) {
        sessionNameToUse = sessionContext;
      }
    } catch (error) {
      // Just log and continue - session detection is optional
      log.debug("Failed to detect session from repo path", {
        error: getErrorMessage(error),
        repoPath: params.repo,
      });
    }
  }

  // If session is still not set, try to detect from current directory
  if (!sessionNameToUse) {
    try {
      const currentDir = process.cwd();
      const sessionContext = await deps.getCurrentSession(currentDir);
      if (sessionContext) {
        sessionNameToUse = sessionContext;
      }
    } catch (error) {
      // Just log and continue - session detection is optional
      log.debug("Failed to detect session from current directory", {
        error: getErrorMessage(error),
        currentDir: process.cwd(),
      });
    }
  }

  // Validate that we have a session to work with
  if (!sessionNameToUse) {
    throw new ValidationError("No session detected. Please provide a session name or task ID");
  }

  // Get the session record
  const sessionRecord = await deps.sessionDB.getSession(sessionNameToUse);
  if (!sessionRecord) {
    throw new ResourceNotFoundError(
      `Session "${sessionNameToUse}" not found`,
      "session",
      sessionNameToUse
    );
  }

  // If no taskId from params, use the one from session record
  if (!taskId && sessionRecord.taskId) {
    taskId = sessionRecord.taskId;
  }

  // Get session workdir
  const sessionWorkdir = await deps.sessionDB.getSessionWorkdir(sessionNameToUse);

  // Track warnings from non-fatal data-gathering failures
  const warnings: string[] = [];

  // Determine PR branch name (pr/<session-name>)
  const prBranchToUse = params.prBranch || `pr/${sessionNameToUse}`;
  const baseBranch = "main"; // Default base branch, could be made configurable

  // Initialize result
  const result: SessionReviewResult = {
    session: sessionNameToUse,
    taskId,
    prBranch: prBranchToUse,
    baseBranch,
  };

  // 1. Get task specification if available
  if (taskId) {
    try {
      const taskService = deps.taskService;

      // Check if taskService has getTaskSpecData method dynamically
      if ("getTaskSpecData" in taskService && typeof taskService.getTaskSpecData === "function") {
        const taskSpec = await taskService.getTaskSpecData(taskId);
        result.taskSpec = taskSpec;
      } else {
        log.debug("Task service does not support getTaskSpecData method");
      }
    } catch (error) {
      const msg = `Could not retrieve task specification for ${taskId}: ${getErrorMessage(error)}`;
      log.debug(msg);
      warnings.push(msg);
    }
  }

  // 2. Get PR description (from git log of the PR branch)
  try {
    // First check if the branch exists remotely
    const remoteBranchOutput = await deps.gitService.execInRepository(
      sessionWorkdir,
      `git ls-remote --heads origin ${prBranchToUse}`
    );
    const remoteBranchExists = remoteBranchOutput.trim().length > 0;

    if (remoteBranchExists) {
      // Fetch the PR branch to ensure we have latest
      await deps.gitService.execInRepository(sessionWorkdir, `git fetch origin ${prBranchToUse}`);

      // Get the PR description from the remote branch's last commit
      const prDescription = await deps.gitService.execInRepository(
        sessionWorkdir,
        `git log -1 --pretty=format:%B origin/${prBranchToUse}`
      );

      result.prDescription = prDescription;
    } else {
      // Check if branch exists locally
      const localBranchOutput = await deps.gitService.execInRepository(
        sessionWorkdir,
        `git show-ref --verify --quiet refs/heads/${prBranchToUse} || echo "not-exists"`
      );
      const localBranchExists = localBranchOutput.trim() !== "not-exists";

      if (localBranchExists) {
        // Get the PR description from the local branch's last commit
        const prDescription = await deps.gitService.execInRepository(
          sessionWorkdir,
          `git log -1 --pretty=format:%B ${prBranchToUse}`
        );

        result.prDescription = prDescription;
      }
    }
  } catch (error) {
    const msg = `Error getting PR description: ${getErrorMessage(error)}`;
    log.debug(msg, { prBranch: prBranchToUse });
    warnings.push(msg);
  }

  // 3. Get diff stats and full diff
  let diffObtained = false;
  try {
    // Fetch latest changes
    await deps.gitService.execInRepository(sessionWorkdir, "git fetch origin");

    // Get diff stats
    const diffStatsOutput = await deps.gitService.execInRepository(
      sessionWorkdir,
      `git diff --stat origin/${baseBranch}...origin/${prBranchToUse}`
    );

    // Parse diff stats
    const statsMatch = diffStatsOutput.match(
      /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/
    );
    if (statsMatch) {
      result.diffStats = {
        filesChanged: parseInt(statsMatch[1] || "0", 10),
        insertions: parseInt(statsMatch[2] || "0", 10),
        deletions: parseInt(statsMatch[3] || "0", 10),
      };
    }

    // Get full diff
    const diffOutput = await deps.gitService.execInRepository(
      sessionWorkdir,
      `git diff origin/${baseBranch}...origin/${prBranchToUse}`
    );

    result.diff = diffOutput;
    diffObtained = true;
  } catch (error) {
    const msg = `Error getting diff from remote refs: ${getErrorMessage(error)}`;
    log.debug(msg, { baseBranch, prBranch: prBranchToUse });
    warnings.push(msg);
  }

  // 3b. Fallback: try local branch refs if remote diff failed
  if (!diffObtained) {
    try {
      let currentBranch: string | undefined;
      try {
        currentBranch = await deps.gitService.getCurrentBranch(sessionWorkdir);
      } catch {
        // ignore
      }
      const headRef = currentBranch || prBranchToUse;

      const diffStatsOutput = await deps.gitService.execInRepository(
        sessionWorkdir,
        `git diff --stat ${baseBranch}...${headRef}`
      );
      const diffOutput = await deps.gitService.execInRepository(
        sessionWorkdir,
        `git diff ${baseBranch}...${headRef}`
      );
      if (diffOutput && diffOutput.trim().length > 0) {
        result.diff = diffOutput;
        const statsMatch = diffStatsOutput.match(
          /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/
        );
        if (statsMatch) {
          result.diffStats = {
            filesChanged: parseInt(statsMatch[1] || "0", 10),
            insertions: parseInt(statsMatch[2] || "0", 10),
            deletions: parseInt(statsMatch[3] || "0", 10),
          };
        }
        diffObtained = true;
      }
    } catch (error) {
      const msg = `Error getting diff from local refs: ${getErrorMessage(error)}`;
      log.debug(msg);
      warnings.push(msg);
    }
  }

  if (!diffObtained) {
    warnings.push("Could not obtain diff content via any method (remote refs or local refs)");
  }

  // Attach warnings if any were collected
  if (warnings.length > 0) {
    result.warnings = warnings;
  }

  return result;
}

// Re-export types from session-db module for convenience
export type { SessionRecord, SessionDbState } from "./session/session-db";

// Re-export the SessionDbAdapter class
export { SessionDbAdapter } from "./session/session-db-adapter";

// SessionDB compatibility removed - use createSessionProvider directly

// Re-export session command functions with shorter names for adapters
export { listSessionsFromParams as sessionList };
export { getSessionFromParams as sessionGet };
export { startSessionFromParams as sessionStart };
export { deleteSessionFromParams as sessionDelete };
export { getSessionDirFromParams as sessionDir };
export { updateSessionFromParams as sessionUpdate };
export { approveSessionFromParams as sessionApprove };
// ❌ REMOVED: export alias for deprecated sessionPrFromParams
// Use sessionPr() from './session/commands/pr-command.ts' instead
export { inspectSessionFromParams as sessionInspect };

// Export new session-scoped git commands
export { sessionCommit };

import {
  MinskyError,
  ResourceNotFoundError,
  ValidationError,
  getErrorMessage,
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
import { type GitServiceInterface } from "./git";
import { createGitService } from "./git";
import { ConflictDetectionService } from "./git/conflict-detection";
import { resolveRepoPath } from "./repo-utils";
import { createSessionProvider } from "./session/session-db-adapter";
import {
  resolveRepositoryAndBackend,
  detectRepositoryBackendTypeFromUrl,
} from "./session/repository-backend-detection";
import { type TaskServiceInterface } from "./tasks";
import { createConfiguredTaskService } from "./tasks/taskService";

import {
  type SessionReviewParams,
  type SessionReviewResult,
  sessionReviewImpl,
} from "./session/session-review-operations";
import {
  type WorkspaceUtilsInterface,
  getCurrentSession,
  getCurrentSessionContext,
} from "./workspace";
import * as WorkspaceUtils from "./workspace";
import { resolveSessionContextWithFeedback } from "./session/session-context-resolver";
import { approveSessionPr } from "./session/session-approval-operations";
import { sessionCommit } from "./session/session-commands";
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

// Re-export review types from sub-module for backward compatibility
export type { SessionReviewParams, SessionReviewResult };

/**
 * Reviews a session PR by gathering and displaying relevant information.
 * Delegates to sessionReviewImpl in session-review-operations sub-module.
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
  return sessionReviewImpl(params, depsInput);
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

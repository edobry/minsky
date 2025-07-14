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
  createErrorContext
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
import {
  type WorkspaceUtilsInterface,
  getCurrentSession,
  getCurrentSessionContext,
} from "./workspace";
import * as WorkspaceUtils from "./workspace";
import { SessionDbAdapter } from "./session/session-db-adapter";
import { createTaskFromDescription } from "./templates/session-templates";
import { resolveSessionContextWithFeedback } from "./session/session-context-resolver";
import { startSessionImpl } from "./session/session-start-operations";
import { 
  getSessionImpl, 
  listSessionsImpl, 
  deleteSessionImpl, 
  getSessionDirImpl, 
  inspectSessionImpl 
} from "./session/session-lifecycle-operations";
import { 
  updateSessionImpl, 
  checkPrBranchExistsOptimized, 
  updatePrStateOnCreation, 
  updatePrStateOnMerge,
  extractPrDescription
} from "./session/session-update-operations";
import { sessionPrImpl } from "./session/session-pr-operations";
import { approveSessionImpl } from "./session/session-approve-operations";
import { 
  sessionReviewImpl, 
  type SessionReviewParams, 
  type SessionReviewResult 
} from "./session/session-review-operations";

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
    createdAt?: string;   // When PR branch was created
    mergedAt?: string;    // When merged (for cleanup)
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
  // Create dependencies with defaults
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
  const { name, task, repo } = params;

  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
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
  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
  };

  let sessionName: string;

  if (params.task && !params.name) {
    // Find session by task ID
    const normalizedTaskId = taskIdSchema.parse(params.task);
    const session = await deps.sessionDB.getSessionByTaskId(normalizedTaskId);

    if (!session) {
      throw new ResourceNotFoundError(`No session found for task ID "${normalizedTaskId}"`);
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
    throw new ResourceNotFoundError(`Session "${sessionName}" not found`);
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
  // Set up dependencies with defaults
  const deps = {
    gitService: depsInput?.gitService || createGitService(),
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    getCurrentSession: depsInput?.getCurrentSession || getCurrentSession,
  };

  return updateSessionImpl(params, deps);
}



/**
 * Interface-agnostic function for creating a PR for a session
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
  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    gitService: depsInput?.gitService || createGitService(),
  };

  return sessionPrImpl(params, deps);
}

/**
 * Approves and merges a session PR branch
 */
export async function approveSessionFromParams(
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
  return approveSessionImpl(params, depsInput);
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
  json?: boolean;
}): Promise<Session | null> {
  // Auto-detect the current session from the workspace
  const context = await getCurrentSessionContext(process.cwd());

  if (!context?.sessionId) {
    throw new ResourceNotFoundError("No session detected for the current workspace");
  }

  const session = await createSessionProvider().getSession(context.sessionId);

  return session;
}

/**
 * Interface for session review parameters
 */
// SessionReviewParams and SessionReviewResult interfaces are now imported from ./session/session-review-operations

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
  return sessionReviewImpl(params, depsInput);
}

// Re-export types from session-db module for convenience
export type { SessionRecord, SessionDbState } from "./session/session-db";

// Re-export the SessionDbAdapter class
export { SessionDbAdapter } from "./session/session-db-adapter";

// Export SessionDB as function for backward compatibility with existing imports
// This replaces the old class-based compatibility layer with a cleaner function-based approach
export const SessionDB = createSessionProvider;

import { existsSync, rmSync } from "fs";
import { readFile, writeFile, mkdir, access, rename } from "fs/promises";
import { join } from "path";
import { 
  MinskyError, 
  ResourceNotFoundError, 
  ValidationError,
  getErrorMessage,
  createCommandFailureMessage,
  createErrorContext
} from "../errors/index.js";
import { taskIdSchema } from "../schemas/common.js";
import type {
  SessionListParams,
  SessionGetParams,
  SessionStartParams,
  SessionDeleteParams,
  SessionDirParams,
  SessionUpdateParams,
  SessionPrParams,
} from "../schemas/session.js";
import { log } from "../utils/logger.js";
import { installDependencies } from "../utils/package-manager.js";
import { type GitServiceInterface, preparePrFromParams } from "./git.js";
import { createGitService } from "./git.js";
import { normalizeRepoName, resolveRepoPath } from "./repo-utils.js";
import { TaskService, TASK_STATUS, type TaskServiceInterface } from "./tasks.js";
import {
  type WorkspaceUtilsInterface,
  getCurrentSession,
  getCurrentSessionContext,
} from "./workspace.js";
import * as WorkspaceUtils from "./workspace.js";

export interface SessionRecord {
  session: string;
  repoName: string;
  repoUrl: string;
  createdAt: string;
  taskId?: string;
  repoPath?: string; // Add repoPath to the interface
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
}

export interface Session {
  session: string;
  repoUrl?: string;
  repoName?: string;
  branch?: string;
  createdAt?: string;
  taskId?: string;
  repoPath?: string;
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
 * Session database operations
 */
export class SessionDB implements SessionProviderInterface {
  private readonly dbPath: string;
  private readonly baseDir: string; // Add baseDir property

  constructor(dbPath?: string) {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");

    if (dbPath) {
      this.dbPath = dbPath;
      // For custom dbPath, set baseDir based on a parallel directory structure
      this.baseDir = join(dbPath, "..", "..", "git");
    } else {
      this.dbPath = join(xdgStateHome, "minsky", "session-db.json");
      this.baseDir = join(xdgStateHome, "minsky", "git");
    }
  }

  private async ensureDbDir(): Promise<void> {
    const dbDir = join(this.dbPath, "..");
    await mkdir(dbDir, { recursive: true });
  }

  private async readDb(): Promise<SessionRecord[]> {
    try {
      if (!existsSync(this.dbPath)) {
        return [];
      }
      const data = await readFile(this.dbPath, "utf8");
      const sessions = JSON.parse(data);

      // Migrate existing sessions to include repoName
      return sessions.map((session: SessionRecord) => {
        if (!session.repoName && session.repoUrl) {
          session.repoName = normalizeRepoName(session.repoUrl);
        }
        return session;
      });
    } catch (e) {
      return [];
    }
  }

  // Alias for readDb to maintain backward compatibility with tests
  async getSessions(): Promise<SessionRecord[]> {
    return this.readDb();
  }

  private async writeDb(sessions: SessionRecord[]): Promise<void> {
    try {
      await this.ensureDbDir();
      await writeFile(this.dbPath, JSON.stringify(sessions, null, 2));
    } catch (error) {
      log.error(getErrorMessage(error));
    }
  }

  // Alias for writeDb to maintain backward compatibility with tests
  async saveSessions(sessions: SessionRecord[]): Promise<void> {
    return this.writeDb(sessions);
  }

  async addSession(record: SessionRecord): Promise<void> {
    const sessions = await this.readDb();
    sessions.push(record);
    await this.writeDb(sessions);
  }

  async listSessions(): Promise<SessionRecord[]> {
    return this.readDb();
  }

  async getSession(session: string): Promise<SessionRecord | null> {
    const sessions = await this.readDb();
    return sessions.find((s) => s.session === session) || null;
  }

  async updateSession(
    session: string,
    updates: Partial<Omit<SessionRecord, "session">>
  ): Promise<void> {
    const sessions = await this.readDb();
    const index = sessions.findIndex((s) => s.session === session);
    if (index !== -1) {
      const { session: _, ...safeUpdates } = updates as any;
      sessions[index] = { ...sessions[index], ...safeUpdates };
      await this.writeDb(sessions);
    }
  }

  async getSessionByTaskId(taskId: string): Promise<SessionRecord | null> {
    try {
      // Normalize both stored and input task IDs to allow matching with or without #
      const normalize = (id: string | undefined) => {
        if (!id) return undefined;
        return id.startsWith("#") ? id : `#${id}`;
      };
      const sessions = await this.readDb();
      const normalizedInput = normalize(taskId);
      const found = sessions.find((s) => normalize(s.taskId) === normalizedInput);
      return found || null; // Ensure we return null, not undefined
    } catch (error) {
      log.error(getErrorMessage(error));
      return null;
    }
  }

  async deleteSession(session: string): Promise<boolean> {
    try {
      const sessions = await this.readDb();
      const index = sessions.findIndex((s) => s.session === session);
      if (index === -1) {
        return false;
      }
      sessions.splice(index, 1);
      await this.writeDb(sessions);
      return true;
    } catch (error) {
      log.error(getErrorMessage(error));
      return false;
    }
  }

  /**
   * Gets the repository path for a session, checking both legacy and new paths
   * @param record The session record or session result
   * @returns The repository path
   */
  async getRepoPath(record: SessionRecord | any): Promise<string> {
    // Add defensive checks for the input to avoid paths[1] error
    if (!record) {
      throw new Error("Session record is required");
    }

    // Special handling for SessionResult type returned by startSessionFromParams
    if (record.sessionRecord) {
      return this.getRepoPath(record.sessionRecord);
    }

    // Special handling for CloneResult
    if (record.cloneResult?.workdir) {
      return record.cloneResult.workdir;
    }

    // Handle case when repoName or session is missing
    if (!record.repoName || !record.session) {
      // If we have repoPath, use it directly
      if (record.repoPath) {
        return record.repoPath;
      }
      // For workdir in some objects
      if (record.workdir) {
        return record.workdir;
      }
      throw new Error("Invalid session record: missing repoName or session");
    }

    // If the record already has a repoPath, use that
    if (record.repoPath) {
      return record.repoPath;
    }

    // Fix for local repository paths: handle the case where repoName contains slashes
    // GitService.clone normalizes slashes to dashes, so we need to do the same here
    let normalizedRepoName = record.repoName;
    if (normalizedRepoName.startsWith("local/")) {
      // Replace slashes with dashes in the path segments after "local/"
      const parts = normalizedRepoName.split("/");
      if (parts.length > 1) {
        // Keep "local" as is, but normalize the rest
        normalizedRepoName = `${parts[0]}-${parts.slice(1).join("-")}`;
      }
    }

    // Check for new path first (with sessions subdirectory)
    const newPath = join(this.baseDir, normalizedRepoName, "sessions", record.session);
    if (await this.repoExists(newPath)) {
      return newPath;
    }

    // Try another common pattern for local repos
    const altPath = join(
      this.baseDir,
      normalizedRepoName.replace(/\//g, "-"),
      "sessions",
      record.session
    );
    if (await this.repoExists(altPath)) {
      return altPath;
    }

    // Fall back to legacy path
    const legacyPath = join(this.baseDir, normalizedRepoName, record.session);
    if (await this.repoExists(legacyPath)) {
      return legacyPath;
    }

    // Default to new path structure even if it"s not exist yet
    try {
      // If the directory doesn't exist, try to create it
      // This ensures session directories are created even if git clone encounters issues
      await mkdir(join(this.baseDir, normalizedRepoName, "sessions"), { recursive: true });
      return newPath;
    } catch (error) {
      // If we can't create the directory, fall back to the original path
      log.error(`Warning: Failed to create session directory: ${getErrorMessage(error)}`);
      return newPath;
    }
  }

  /**
   * Check if a repository exists at the given path
   * @param path The repository path to check
   * @returns true if the repository exists
   */
  private async repoExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Get the new repository path with sessions subdirectory for a session
   * @param repoName The repository name
   * @param sessionId The session ID
   * @returns The new repository path
   */
  getNewSessionRepoPath(repoName: string, sessionId: string): string {
    return join(this.baseDir, repoName, "sessions", sessionId);
  }

  /**
   * Get the working directory for a session
   * For backward compatibility with tests
   * @param sessionName The session name
   * @returns The working directory path
   */
  async getSessionWorkdir(sessionName: string): Promise<string> {
    const session = await this.getSession(sessionName);
    if (!session) {
      throw new Error(`Session "${sessionName}" not found.`);
    }
    return this.getRepoPath(session);
  }

  /**
   * Migrate all sessions to use the sessions subdirectory structure
   * This is called once to migrate existing repositories
   */
  async migrateSessionsToSubdirectory(): Promise<void> {
    const sessions = await this.readDb();
    let modified = false;

    for (const session of sessions) {
      // Skip sessions that already have a repoPath
      if (session.repoPath?.includes("/sessions/")) {
        continue;
      }

      const legacyPath = join(this.baseDir, session.repoName, session.session);
      const newPath = join(this.baseDir, session.repoName, "sessions", session.session);

      // Check if legacy path exists
      if (await this.repoExists(legacyPath)) {
        // Create new path directory structure
        await mkdir(join(this.baseDir, session.repoName, "sessions"), { recursive: true });

        // Move repository to new location
        try {
          await rename(legacyPath, newPath);
          // Update session record
          session.repoPath = newPath;
          modified = true;
        } catch (err) {
          log.error(`Failed to migrate session ${session.session}:`, { error: err });
        }
      }
    }

    // Save changes
    if (modified) {
      await this.writeDb(sessions);
    }
  }
}

/**
 * Gets session details based on parameters
 * Using proper dependency injection for better testability
 */
export async function getSessionFromParams(
  params: SessionGetParams,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
  }
): Promise<Session | null> {
  const { name, task } = params;

  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
  };

  // If task is provided but no name, find session by task ID
  if (task && !name) {
    const normalizedTaskId = taskIdSchema.parse(task);
    return deps.sessionDB.getSessionByTaskId(normalizedTaskId);
  }

  // If name is provided, get by name
  if (name) {
    return deps.sessionDB.getSession(name);
  }

  // No name or task - error case
  throw new ResourceNotFoundError("You must provide either a session name or task ID");
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

  return deps.sessionDB.listSessions();
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
  // Validate parameters using Zod schema (already done by type)
  const { name, repo, task, branch, noStatusUpdate, quiet, json, skipInstall, packageManager } =
    params;

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

  try {
    log.debug("Starting session with params", {
      name,
      task,
      inputBranch: branch,
      noStatusUpdate,
      quiet,
      json,
      skipInstall,
      packageManager,
    });

    const currentDir = process.env.PWD || process.cwd();
    const isInSession = await deps.workspaceUtils.isSessionWorkspace(currentDir);
    if (isInSession) {
      throw new MinskyError(
        "Cannot create a new session while inside a session workspace. Please return to the main workspace first."
      );
    }

    // Determine repo URL or path first
    let repoUrl = repo;
    if (!repoUrl) {
      try {
        repoUrl = await deps.resolveRepoPath({});
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        throw new MinskyError(
          `--repo is required (not in a git repo and no --repo provided): ${error.message}`
        );
      }
    }

    // Determine the session name using task ID if provided
    let sessionName = name;
    let taskId: string | undefined = task;

    if (taskId && !sessionName) {
      // Normalize the task ID format using Zod validation
      const normalizedTaskId = taskIdSchema.parse(taskId);
      taskId = normalizedTaskId;

      // Verify the task exists
      const taskObj = await deps.taskService.getTask(normalizedTaskId);
      if (!taskObj) {
        throw new ResourceNotFoundError(`Task ${taskId} not found`, "task", taskId);
      }

      // Use the task ID as the session name
      sessionName = `task${taskId}`;
    }

    if (!sessionName) {
      throw new ValidationError("Either session name or task ID must be provided");
    }

    // Check if session already exists
    const existingSession = await deps.sessionDB.getSession(sessionName);
    if (existingSession) {
      throw new MinskyError(`Session '${sessionName}' already exists`);
    }

    // Check if a session already exists for this task
    if (taskId) {
      const existingSessions = await deps.sessionDB.listSessions();
      const taskSession = existingSessions.find((s: SessionRecord) => {
        const normalizedSessionTaskId = s.taskId?.startsWith("#") ? s.taskId : `#${s.taskId}`;
        const normalizedInputTaskId = taskId?.startsWith("#") ? taskId : `#${taskId}`;
        return normalizedSessionTaskId === normalizedInputTaskId;
      });

      if (taskSession) {
        throw new MinskyError(
          `A session for task ${taskId} already exists: '${taskSession.session}'`
        );
      }
    }

    // Extract the repository name
    const repoName = normalizeRepoName(repoUrl);

    // Normalize the repo name for local repositories to ensure path consistency
    let normalizedRepoName = repoName;
    if (repoName.startsWith("local/")) {
      // Replace slashes with dashes in the path segments after "local/"
      const parts = repoName.split("/");
      if (parts.length > 1) {
        // Keep "local" as is, but normalize the rest
        normalizedRepoName = `${parts[0]}-${parts.slice(1).join("-")}`;
      }
    } else {
      // For other repository types, normalize as usual
      normalizedRepoName = repoName.replace(/[^a-zA-Z0-9-_]/g, "-");
    }

    // Generate the expected repository path
    const sessionDir =
      deps.sessionDB instanceof SessionDB
        ? deps.sessionDB.getNewSessionRepoPath(normalizedRepoName, sessionName)
        : join(
          process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state"),
          "minsky",
          "git",
          normalizedRepoName,
          "sessions",
          sessionName
        );

    // Check if session directory already exists and clean it up
    if (existsSync(sessionDir)) {
      try {
        rmSync(sessionDir, { recursive: true, force: true });
      } catch (error) {
        throw new MinskyError(
          `Failed to clean up existing session directory: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Prepare session record but don't add to DB yet
    const sessionRecord: SessionRecord = {
      session: sessionName,
      repoUrl,
      repoName,
      createdAt: new Date().toISOString(),
      taskId,
      branch: branch || sessionName,
      repoPath: sessionDir, // Include the repository path explicitly
    };

    let sessionAdded = false;
    // Define branchName outside try block so it's available in return statement
    const branchName = branch || sessionName;

    try {
      // First clone the repo
      const gitCloneResult = await deps.gitService.clone({
        repoUrl,
        session: sessionName,
      });

      // Create a branch based on the session name - use branchWithoutSession
      // since session record hasn't been added to DB yet
      const branchResult = await deps.gitService.branchWithoutSession({
        repoName: normalizeRepoName(repoUrl),
        session: sessionName,
        branch: branchName,
      });

      // Only add session to DB after git operations succeed
      await deps.sessionDB.addSession(sessionRecord);
      sessionAdded = true;
    } catch (gitError) {
      // Clean up session record if it was added but git operations failed
      if (sessionAdded) {
        try {
          await deps.sessionDB.deleteSession(sessionName);
        } catch (cleanupError) {
          log.error("Failed to cleanup session record after git error", {
            sessionName,
            gitError: gitError instanceof Error ? gitError.message : String(gitError),
            cleanupError:
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }

      // Clean up the directory if it was created
      if (existsSync(sessionDir)) {
        try {
          rmSync(sessionDir, { recursive: true, force: true });
        } catch (cleanupError) {
          log.error("Failed to cleanup session directory after git error", {
            sessionDir,
            gitError: gitError instanceof Error ? gitError.message : String(gitError),
            cleanupError:
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
      }

      throw gitError;
    }

    // Install dependencies if not skipped
    if (!skipInstall) {
      try {
        const { success, error } = await installDependencies(sessionDir, {
          packageManager: packageManager,
          quiet: quiet,
        });

        if (!success && !quiet) {
          log.cliWarn(`Warning: Dependency installation failed. You may need to run install manually.
Error: ${error}`);
        }
      } catch (installError) {
        // Log but don't fail session creation
        if (!quiet) {
          log.cliWarn(
            `Warning: Dependency installation failed. You may need to run install manually.
Error: ${installError instanceof Error ? installError.message : String(installError)}`
          );
        }
      }
    }

    // Update task status to IN-PROGRESS if requested and if we have a task ID
    if (taskId && !noStatusUpdate) {
      try {
        // Get the current status first
        const previousStatus = await deps.taskService.getTaskStatus(taskId);

        // Update the status to IN-PROGRESS
        await deps.taskService.setTaskStatus(taskId, TASK_STATUS.IN_PROGRESS);
      } catch (error) {
        // Log the error but don't fail the session creation
        log.cliWarn(
          `Warning: Failed to update status for task ${taskId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    if (!quiet) {
      log.debug(`Started session for task ${taskId}`, { session: sessionName });
    }

    return {
      session: sessionName,
      repoUrl,
      repoName: normalizeRepoName(repoUrl),
      branch: branchName,
      taskId,
    };
  } catch (error) {
    if (error instanceof MinskyError) {
      throw error;
    } else {
      throw new MinskyError(
        `Failed to start session: ${getErrorMessage(error)}`,
        error
      );
    }
  }
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
  const { name, task } = params;

  // Set up dependencies with defaults
  const deps = {
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
  };

  if (task && !name) {
    // Find session by task ID
    const normalizedTaskId = taskIdSchema.parse(task);
    const session = await deps.sessionDB.getSessionByTaskId(normalizedTaskId);

    if (!session) {
      throw new ResourceNotFoundError(`No session found for task ID "${normalizedTaskId}"`);
    }

    // Delete by name
    return deps.sessionDB.deleteSession(session.session);
  }

  if (!name) {
    throw new ResourceNotFoundError("You must provide either a session name or task ID");
  }

  return deps.sessionDB.deleteSession(name);
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
    throw new ResourceNotFoundError("You must provide either a session name or task ID");
  }

  const session = await deps.sessionDB.getSession(sessionName);

  if (!session) {
    throw new ResourceNotFoundError(`Session "${sessionName}" not found`);
  }

  // Get repo path from session
  const repoPath = session.repoPath;

  if (!repoPath) {
    throw new MinskyError(`Session "${sessionName}" does not have a repository path`);
  }

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
  let { name, branch, remote, noStash, noPush, force } = params;

  log.debug("updateSessionFromParams called", { params });

  // Auto-detect session name if not provided
  if (!name) {
    try {
      // Try to detect session from current directory path
      const currentDir = process.cwd();
      const pathParts = currentDir.split("/");
      const sessionsIndex = pathParts.indexOf("sessions");
      if (sessionsIndex >= 0 && sessionsIndex < pathParts.length - 1) {
        name = pathParts[sessionsIndex + 1];
        log.debug("Auto-detected session from path", { name, currentDir });
      }
    } catch (error) {
      log.debug("Failed to auto-detect session from path", { error });
    }
  }

  // Input validation
  if (!name) {
    throw new ValidationError(
      "Session name is required. Please provide a session name or run this command from within a session workspace."
    );
  }

  // Set up dependencies with defaults
  const deps = {
    gitService: depsInput?.gitService || createGitService(),
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    getCurrentSession: depsInput?.getCurrentSession || getCurrentSession,
  };

  log.debug("Dependencies set up", {
    hasGitService: !!deps.gitService,
    hasSessionDB: !!deps.sessionDB,
  });

  try {
    // Get session record
    log.debug("Getting session record", { name });
    const sessionRecord = await deps.sessionDB.getSession(name);
    if (!sessionRecord) {
      throw new ResourceNotFoundError(`Session '${name}' not found`, "session", name);
    }

    log.debug("Session record found", { sessionRecord });

    // Get session working directory
    const workdir = deps.gitService.getSessionWorkdir(sessionRecord.repoName, name);
    log.debug("Session workdir determined", { workdir });

    // Validate that the session workspace directory exists
    try {
      await access(workdir);
      log.debug("Workspace directory exists", { workdir });
    } catch (error) {
      throw new MinskyError(
        `Session workspace directory does not exist: ${workdir}. ` +
          `The session '${name}' exists in the database but its workspace directory is missing. ` +
          "This can happen if the directory was manually deleted or the session creation was interrupted. " +
          `Please delete the session with 'minsky session delete ${name}' and recreate it.`
      );
    }

    // Check if the workspace is dirty using git status command directly
    log.debug("Checking workspace status", { workdir });
    const statusOutput = await deps.gitService.execInRepository(workdir, "git status --porcelain");
    const isDirty = statusOutput.trim().length > 0;
    log.debug("Workspace status checked", { isDirty, statusOutput: statusOutput.trim() });

    if (isDirty && !force) {
      throw new MinskyError(
        "Session workspace has uncommitted changes. Commit or stash your changes before updating, or use --force to override."
      );
    }

    // Stash changes if needed
    if (!noStash) {
      log.debug("Stashing changes", { workdir });
      await deps.gitService.stashChanges(workdir);
      log.debug("Changes stashed");
    }

    let stashError: unknown;

    try {
      // Pull latest changes
      log.debug("Pulling latest changes", { workdir, remote: remote || "origin" });
      await deps.gitService.pullLatest(workdir, remote || "origin");
      log.debug("Latest changes pulled");

      // Merge specified branch from remote (this was the key fix)
      const branchToMerge = branch || "main";
      const remoteBranchToMerge = `${remote || "origin"}/${branchToMerge}`;
      log.debug("Merging branch", { branchToMerge: remoteBranchToMerge, workdir });
      const mergeResult = await deps.gitService.mergeBranch(workdir, remoteBranchToMerge);
      log.debug("Branch merge completed", { mergeResult });

      if (mergeResult.conflicts) {
        // Check if we're in a situation where session changes were already merged to main
        const currentDir = process.cwd();
        const isSessionWorkspace = currentDir.includes("/sessions/");

        const conflictMessage = isSessionWorkspace
          ? `
🚫 Merge conflicts detected when updating session '${name}'

This usually happens when your session changes were already merged into main branch.

Current situation:
• Session branch: ${name}
• Trying to merge: ${remoteBranchToMerge}
• Location: ${workdir}

Resolution options:

1️⃣ If your changes are already in main (most common):
   Skip the session update - your session is ready for PR creation:

   minsky session pr --title "Your PR title"

2️⃣ If you need to resolve conflicts manually:
   cd ${workdir}
   git status
   # Resolve conflicts in the listed files
   git add .
   git commit -m "resolve merge conflicts"
   minsky session update

3️⃣ If you want to reset your session to match main:
   cd ${workdir}
   git reset --hard ${remoteBranchToMerge}
   git push --force-with-lease

💡 For most cases, option 1 (skip update, create PR directly) is the right choice.
          `.trim()
          : `Merge conflicts detected when merging ${remoteBranchToMerge} into session '${name}'. Please resolve conflicts manually in ${workdir}.`;

        throw new MinskyError(conflictMessage);
      }

      // Push changes if needed
      if (!noPush) {
        log.debug("Pushing changes", { workdir, remote: remote || "origin" });
        await deps.gitService.push({
          repoPath: workdir,
          remote: remote || "origin",
        });
      }
    } finally {
      // Always try to restore stashed changes
      if (!noStash) {
        try {
          log.debug("Restoring stashed changes", { workdir });
          await deps.gitService.popStash(workdir);
          log.debug("Stashed changes restored");
        } catch (error) {
          stashError = error;
        }
      }
    }

    // Handle stash error outside finally block
    if (stashError) {
      log.error("Failed to restore stashed changes:", { error: stashError });
      throw new MinskyError(
        "Session was updated, but failed to restore stashed changes. Please resolve manually.",
        stashError
      );
    }

    log.debug("Session update completed successfully", { sessionName: name });

    // Return the updated session information
    return {
      session: sessionRecord.session,
      repoName: sessionRecord.repoName,
      repoUrl: sessionRecord.repoUrl,
      branch: sessionRecord.branch,
      createdAt: sessionRecord.createdAt,
      taskId: sessionRecord.taskId,
      repoPath: workdir,
    };
  } catch (error) {
    log.error("Session update failed", {
      error: error instanceof Error ? error.message : String(error),
      name,
    });
    if (error instanceof MinskyError) {
      throw error;
    } else {
      throw new MinskyError(
        `Failed to update session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}

/**
 * Interface-agnostic function for creating a PR for a session
 */
export async function sessionPrFromParams(params: SessionPrParams): Promise<{
  prBranch: string;
  baseBranch: string;
  title?: string;
  body?: string;
}> {
  try {
    // STEP 1: Validate we're in a session workspace and on a session branch
    const currentDir = process.cwd();
    const isSessionWorkspace = currentDir.includes("/sessions/");
    if (!isSessionWorkspace) {
      throw new MinskyError(
        "session pr command must be run from within a session workspace. Use 'minsky session start' first."
      );
    }

    // Get current git branch
    const gitService = createGitService();
    const currentBranch = await gitService.getCurrentBranch(currentDir);

    // STEP 2: Ensure we're NOT on a PR branch (should fail if on pr/* branch)
    if (currentBranch.startsWith("pr/")) {
      throw new MinskyError(
        `Cannot run session pr from PR branch '${currentBranch}'. Switch to your session branch first.`
      );
    }

    // STEP 3: Verify we're in a session directory (no branch format restriction)
    // The session name will be detected from the directory path or provided explicitly
    // Both task#XXX and named sessions are supported

    // STEP 4: Check for uncommitted changes
    const hasUncommittedChanges = await gitService.hasUncommittedChanges(currentDir);
    if (hasUncommittedChanges) {
      // Get the status of uncommitted changes to show in the error
      let statusInfo = "";
      try {
        const status = await gitService.getStatus(currentDir);
        const changes = [];

        if (status.modified.length > 0) {
          changes.push(`📝 Modified files (${status.modified.length}):`);
          status.modified.forEach((file) => changes.push(`   ${file}`));
        }

        if (status.untracked.length > 0) {
          changes.push(`📄 New files (${status.untracked.length}):`);
          status.untracked.forEach((file) => changes.push(`   ${file}`));
        }

        if (status.deleted.length > 0) {
          changes.push(`🗑️  Deleted files (${status.deleted.length}):`);
          status.deleted.forEach((file) => changes.push(`   ${file}`));
        }

        statusInfo = changes.length > 0 ? changes.join("\n") : "No detailed changes available";
      } catch (statusError) {
        statusInfo = "Unable to get detailed status.";
      }

      throw new MinskyError(
        `
🚫 Cannot create PR with uncommitted changes

You have uncommitted changes in your session workspace that need to be committed first.

Current changes:
${statusInfo}

To fix this, run one of the following:

📝 Commit your changes:
   git add .
   git commit -m "Your commit message"

📦 Or stash your changes temporarily:
   git stash

💡 Then try creating the PR again:
   minsky session pr --title "your title"

Need help? Run 'git status' to see what files have changed.
      `.trim()
      );
    }

    // Handle body content - read from file if bodyPath is provided
    let bodyContent = params.body;
    if (params.bodyPath) {
      try {
        // Resolve relative paths relative to current working directory
        const filePath = require("path").resolve(params.bodyPath);
        bodyContent = await readFile(filePath, "utf-8");

        if (!bodyContent.trim()) {
          throw new ValidationError(`Body file is empty: ${params.bodyPath}`);
        }

        log.debug(`Read PR body from file: ${filePath}`, {
          fileSize: bodyContent.length,
          bodyPath: params.bodyPath,
        });
      } catch (error) {
        if (error instanceof ValidationError) {
          throw error;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes("ENOENT") || errorMessage.includes("no such file")) {
          throw new ValidationError(`Body file not found: ${params.bodyPath}`);
        } else if (errorMessage.includes("EACCES") || errorMessage.includes("permission denied")) {
          throw new ValidationError(`Permission denied reading body file: ${params.bodyPath}`);
        } else {
          throw new ValidationError(
            `Failed to read body file: ${params.bodyPath}. ${errorMessage}`
          );
        }
      }
    }

    // Determine the session name
    let sessionName = params.session;
    const sessionDb = createSessionProvider({ workingDir: currentDir });

    // If no session name provided but task ID is, try to find the session by task ID
    if (!sessionName && params.task) {
      const taskId = params.task;
      const sessionRecord = await sessionDb.getSessionByTaskId(taskId);
      if (sessionRecord) {
        sessionName = sessionRecord.session;
      } else {
        throw new MinskyError(`No session found for task ID ${taskId}`);
      }
    }

    // If still no session name, try to detect from current directory
    if (!sessionName) {
      try {
        // Extract session name from path - assuming standard path format
        const pathParts = currentDir.split("/");
        const sessionsIndex = pathParts.indexOf("sessions");
        if (sessionsIndex >= 0 && sessionsIndex < pathParts.length - 1) {
          sessionName = pathParts[sessionsIndex + 1];
        }
      } catch (error) {
        // If detection fails, throw error
        throw new MinskyError(
          "Could not detect session from current directory. Please specify a session name or task ID."
        );
      }

      if (!sessionName) {
        throw new MinskyError(
          "Could not detect session from current directory. Please specify a session name or task ID."
        );
      }
    }

    log.debug(`Creating PR for session: ${sessionName}`, {
      session: sessionName,
      title: params.title,
      hasBody: !!bodyContent,
      bodySource: params.bodyPath ? "file" : "parameter",
      baseBranch: params.baseBranch,
    });

    // STEP 5: Run session update first to merge latest changes from main (unless --no-update is specified)
    if (!params.noUpdate) {
      log.cli("Updating session with latest changes from main...");
      try {
        await updateSessionFromParams({
          name: sessionName,
          repo: params.repo,
          json: false,
        });
        log.cli("Session updated successfully");
      } catch (error) {
        throw new MinskyError(
          `Failed to update session before creating PR: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } else {
      log.cli("Skipping session update (--no-update specified)");
    }

    // STEP 6: Now proceed with PR creation
    const result = await preparePrFromParams({
      session: sessionName,
      title: params.title,
      body: bodyContent,
      baseBranch: params.baseBranch,
      debug: params.debug,
    });

    // Update task status to IN-REVIEW if associated with a task
    if (!params.noStatusUpdate) {
      const sessionRecord = await sessionDb.getSession(sessionName);
      if (sessionRecord?.taskId) {
        try {
          const taskService = new TaskService({
            workspacePath: process.cwd(),
            backend: "markdown",
          });
          await taskService.setTaskStatus(sessionRecord.taskId, TASK_STATUS.IN_REVIEW);
          log.cli(`Updated task #${sessionRecord.taskId} status to IN-REVIEW`);
        } catch (error) {
          log.warn(
            `Failed to update task status: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }

    return result;
  } catch (error) {
    log.error("Error creating PR for session", {
      session: params.session,
      task: params.task,
      bodyPath: params.bodyPath,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
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

  try {
    // Execute git commands to merge the PR branch in the main repository
    // First, check out the base branch
    await deps.gitService.execInRepository(workingDirectory, `git checkout ${baseBranch}`);
    // Fetch latest changes
    await deps.gitService.execInRepository(workingDirectory, "git fetch origin");
    // Perform the fast-forward merge from local PR branch
    await deps.gitService.execInRepository(workingDirectory, `git merge --ff-only ${prBranch}`);

    // Get commit hash and date
    const commitHash = (
      await deps.gitService.execInRepository(workingDirectory, "git rev-parse HEAD")
    ).trim();
    const mergeDate = new Date().toISOString();
    const mergedBy = (
      await deps.gitService.execInRepository(workingDirectory, "git config user.name")
    ).trim();

    // Push the changes
    await deps.gitService.execInRepository(workingDirectory, `git push origin ${baseBranch}`);

    // Delete the PR branch from remote only if it exists there
    try {
      // Check if remote branch exists first
      await deps.gitService.execInRepository(
        workingDirectory,
        `git show-ref --verify --quiet refs/remotes/origin/${prBranch}`
      );
      // If it exists, delete it
      await deps.gitService.execInRepository(
        workingDirectory,
        `git push origin --delete ${prBranch}`
      );
    } catch (error) {
      // Remote branch doesn't exist, which is fine - just log it
      log.debug(`Remote PR branch ${prBranch} doesn't exist, skipping deletion`);
    }

    // Create merge info
    const mergeInfo = {
      session: sessionNameToUse,
      commitHash,
      mergeDate,
      mergedBy,
      baseBranch,
      prBranch,
      taskId,
    };

    // Update task status to DONE if we have a task ID
    if (taskId && deps.taskService.setTaskStatus) {
      try {
        await deps.taskService.setTaskStatus(taskId, TASK_STATUS.DONE);
        log.cli(`Updated task ${taskId} status to DONE`);
      } catch (error) {
        // BUG FIX: Use proper logging instead of console.error and make error visible
        const errorMsg = `Failed to update task status: ${error instanceof Error ? error.message : String(error)}`;
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
        `Failed to approve session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

/**
 * Creates a default SessionProvider implementation
 * This factory function provides a consistent way to get a session provider with optional customization
 */
export function createSessionProvider(options?: {
  dbPath?: string;
  workingDir?: string;
  useNewBackend?: boolean;
}): SessionProviderInterface {
  // Use new configuration-based backend by default, but allow fallback
  if (options?.useNewBackend !== false) {
    const { SessionDbAdapter } = require("./session/session-db-adapter");
    return new SessionDbAdapter(options?.workingDir);
  }

  // Fallback to legacy JSON file implementation
  return new SessionDB(options?.dbPath);
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
    sessionDB: depsInput?.sessionDB || createSessionProvider(),
    gitService: depsInput?.gitService || createGitService(),
    taskService:
      depsInput?.taskService ||
      new TaskService({
        workspacePath: params.repo || process.cwd(),
        backend: "markdown",
      }),
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
        error: error instanceof Error ? error.message : String(error),
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
        error: error instanceof Error ? error.message : String(error),
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
      if (
        "getTaskSpecData" in taskService &&
        typeof (taskService as any).getTaskSpecData === "function"
      ) {
        const taskSpec = await (taskService as any).getTaskSpecData(taskId);
        result.taskSpec = taskSpec;
      } else {
        log.debug("Task service does not support getTaskSpecData method");
      }
    } catch (error) {
      log.debug("Error getting task specification", {
        error: error instanceof Error ? error.message : String(error),
        taskId,
      });
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
        `git show-ref --verify --quiet refs/heads/${prBranchToUse} || echo 'not-exists'`
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
    log.debug("Error getting PR description", {
      error: error instanceof Error ? error.message : String(error),
      prBranch: prBranchToUse,
    });
  }

  // 3. Get diff stats and full diff
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
  } catch (error) {
    log.debug("Error getting diff information", {
      error: error instanceof Error ? error.message : String(error),
      baseBranch,
      prBranch: prBranchToUse,
    });
  }

  return result;
}

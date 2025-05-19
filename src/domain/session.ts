import { join } from "path";
import { readFile, writeFile, mkdir, access, rename } from "fs/promises";
import { existsSync } from "fs";
import { normalizeRepoName } from "./repo-utils.js";
import { MinskyError, ResourceNotFoundError, ValidationError } from "../errors/index.js";
import { taskIdSchema } from "../schemas/common.js";
import type {
  SessionListParams,
  SessionGetParams,
  SessionStartParams,
  SessionDeleteParams,
  SessionDirParams,
  SessionUpdateParams,
} from "../schemas/session.js";
import { GitService, type BranchOptions } from "./git.js";
import { TaskService, TASK_STATUS } from "./tasks.js";
import { isSessionRepository } from "./workspace.js";
import { resolveRepoPath } from "./repo-utils.js";
import { getCurrentSession } from "./workspace.js";
import { normalizeTaskId } from "./tasks/utils.js";
import { z } from "zod";
import * as WorkspaceUtils from "./workspace.js";
import { sessionRecordSchema } from "../schemas/session.js"; // Verified path
import { log } from "../utils/logger.js";

/**
 * Helper function to normalize and validate a task ID
 * @param taskId The raw task ID to normalize and validate
 * @returns The normalized task ID
 * @throws ValidationError if the task ID is invalid
 */
function normalizeAndValidateTaskId(taskId: string): string {
  const normalized = normalizeTaskId(taskId);
  if (!normalized) {
    throw new ValidationError(
      `Invalid task ID: '${taskId}'. Please provide a valid numeric task ID (e.g., 077 or #077).`
    );
  }

  // Skip the schema validation since normalizeTaskId already ensures it's in the correct format
  // This avoids issues with the regex pattern in taskIdSchema
  return normalized;
}

export type SessionRecord = z.infer<typeof sessionRecordSchema>;
export type Session = SessionRecord; // Alias for convenience

export interface SessionResult {
  sessionRecord: SessionRecord;
  cloneResult?: { workdir: string };
  branchResult?: { branch: string };
  statusUpdateResult?: any;
}

/**
 * Session database operations
 */
export class SessionDB {
  private readonly dbPath: string;
  private readonly baseDir: string;

  constructor(options?: { baseDir?: string; dbPath?: string }) {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
    const minskyStateDir = join(xdgStateHome, "minsky");
    this.dbPath = options?.dbPath || join(minskyStateDir, "session-db.json");
    this.baseDir = options?.baseDir || join(minskyStateDir, "git");
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

      // Normalize and migrate session records
      let normalizedCount = 0;
      const normalizedSessions = sessions.map((session: SessionRecord) => {
        let wasNormalized = false;

        // Ensure repoName exists
        if (!session.repoName && session.repoUrl) {
          session.repoName = normalizeRepoName(session.repoUrl);
          wasNormalized = true;
        }

        // Ensure branch field exists - default to session name if missing
        if (!session.branch && session.session) {
          session.branch = session.session;
          wasNormalized = true;
        }

        if (wasNormalized) {
          normalizedCount++;
        }

        return session;
      });

      // If any records were normalized, save them back to disk
      if (normalizedCount > 0) {
        log.debug(`Normalized ${normalizedCount} session records with missing fields`);
        this.writeDb(normalizedSessions).catch((err) => {
          log.error("Failed to save normalized session records", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      return normalizedSessions;
    } catch (e) {
      return [];
    }
  }

  async getSessions(): Promise<SessionRecord[]> {
    return this.readDb();
  }

  private async writeDb(sessions: SessionRecord[]): Promise<void> {
    try {
      log.debug(`Starting writeDb. DB Path: ${this.dbPath}`);
      await this.ensureDbDir();
      log.debug("DB directory ensured.");
      await writeFile(this.dbPath, JSON.stringify(sessions, null, 2));
      log.debug("DB file written successfully.");
    } catch (error) {
      log.error("Error writing session database", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        dbPath: this.dbPath,
      });
    }
  }

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
    sessionNameArg: string, // Renamed to avoid conflict with session property
    updates: Partial<Omit<SessionRecord, "session">>
  ): Promise<void> {
    const sessions = await this.readDb();
    const index = sessions.findIndex((s) => s.session === sessionNameArg); // Use renamed arg
    if (index !== -1) {
      const { session, ...restOfOldRecord } = sessions[index]!; // Add non-null assertion
      sessions[index] = {
        session, // Explicitly keep the original session string
        ...restOfOldRecord,
        ...updates,
      };
      await this.writeDb(sessions);
    }
  }

  async getSessionByTaskId(taskId: string): Promise<SessionRecord | null> {
    try {
      if (!taskId) {
        return null;
      }

      // Use normalizeTaskId directly (doesn't throw exceptions)
      const normalizedInputId = normalizeTaskId(taskId);
      if (!normalizedInputId) {
        log.debug(`Invalid task ID format: ${taskId}`);
        return null;
      }

      // Extract the numeric part for numeric comparison
      const inputNumericId = normalizedInputId.replace(/^#/, "");

      const sessions = await this.readDb();
      const found = sessions.find((s) => {
        if (!s.taskId) return false;

        // Normalize the stored task ID
        const normalizedStoredId = normalizeTaskId(s.taskId);
        if (!normalizedStoredId) return false;

        // Extract the numeric part for comparison
        const storedNumericId = normalizedStoredId.replace(/^#/, "");

        // Compare as numbers to handle leading zeros properly
        return parseInt(storedNumericId, 10) === parseInt(inputNumericId, 10);
      });

      return found || null;
    } catch (error) {
      log.error("Error finding session by task ID", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        taskId,
      });
      return null;
    }
  }

  async deleteSession(session: string): Promise<boolean> {
    try {
      const sessions = await this.readDb();
      const index = sessions.findIndex((s) => s.session === session);
      if (index === -1) {
        log.debug(`Session '${session}' not found in DB.`, { session });
        return false;
      }
      log.debug(`Found session '${session}' at index ${index}.`, { session, index });
      sessions.splice(index, 1);
      log.debug(`Session '${session}' removed from array.`, { session });
      await this.writeDb(sessions);
      log.debug(`writeDb called for session '${session}'.`, { session });
      return true;
    } catch (error) {
      log.error(`Error in deleteSession for '${session}'`, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        session,
      });
      return false;
    }
  }

  async getRepoPath(record: SessionRecord): Promise<string> {
    const newPath = join(this.baseDir, record.repoName, "sessions", record.session);
    const legacyPath = join(this.baseDir, record.repoName, record.session);
    if (record.repoPath) {
      return record.repoPath;
    }
    if (await this.repoExists(newPath)) {
      return newPath;
    }
    if (await this.repoExists(legacyPath)) {
      return legacyPath;
    }
    return newPath;
  }

  private async repoExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch (err) {
      return false;
    }
  }

  getNewSessionRepoPath(repoName: string, sessionId: string): string {
    return join(this.baseDir, repoName, "sessions", sessionId);
  }

  async getSessionWorkdir(sessionName: string): Promise<string> {
    const session = await this.getSession(sessionName);
    if (!session) {
      throw new Error(`Session "${sessionName}" not found.`);
    }
    return this.getRepoPath(session);
  }

  async migrateSessionsToSubdirectory(): Promise<void> {
    const sessions = await this.readDb();
    let modified = false;
    for (const session of sessions) {
      if (session.repoPath && session.repoPath.includes("/sessions/")) {
        continue;
      }
      const legacyPath = join(this.baseDir, session.repoName, session.session);
      const newPath = join(this.baseDir, session.repoName, "sessions", session.session);
      if (await this.repoExists(legacyPath)) {
        await mkdir(join(this.baseDir, session.repoName, "sessions"), { recursive: true });
        try {
          await rename(legacyPath, newPath);
          session.repoPath = newPath;
          modified = true;
        } catch (err) {
          // Failed migration is handled silently
        }
      }
    }
    if (modified) {
      await this.writeDb(sessions);
    }
  }
}

export type SessionDeps = {
  sessionDB: SessionDB;
  gitService: GitService;
  taskService: TaskService;
  workspaceUtils: typeof WorkspaceUtils;
};

function getMinskyStateDir(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
  return join(xdgStateHome, "minsky", "git");
}

export async function createSessionDeps(options?: {
  workspacePath?: string;
}): Promise<SessionDeps> {
  const baseDir = getMinskyStateDir();
  const sessionDBInstance = new SessionDB({ baseDir });
  const gitServiceInstance = new GitService(baseDir);

  // Use the provided workspace path or the current directory for task operations
  // This ensures task lookups happen in the actual repository, not in the state directory
  const workspacePath = options?.workspacePath || process.cwd();
  const taskServiceInstance = new TaskService({
    workspacePath, // Use the actual repository path, not the state directory
    backend: "markdown",
  });

  return {
    sessionDB: sessionDBInstance,
    gitService: gitServiceInstance,
    taskService: taskServiceInstance,
    workspaceUtils: WorkspaceUtils,
  };
}

/**
 * Gets session details based on parameters
 */
export async function getSessionFromParams(params: SessionGetParams): Promise<Session | null> {
  const { name, task } = params;
  const sessionDB = new SessionDB({ baseDir: getMinskyStateDir() });
  if (task && !name) {
    // First normalize the task ID
    const normalizedTaskId = normalizeAndValidateTaskId(task);

    return sessionDB.getSessionByTaskId(normalizedTaskId);
  }
  if (params.name) {
    return sessionDB.getSession(params.name);
  }
  return null;
}

/**
 * Lists all sessions based on parameters
 */
export async function listSessionsFromParams(params: SessionListParams): Promise<Session[]> {
  const sessionDB = new SessionDB({ baseDir: getMinskyStateDir() });
  return sessionDB.listSessions();
}

/**
 * Starts a new session based on parameters
 */
export async function startSessionFromParams(
  params: SessionStartParams,
  depsInput?: SessionDeps
): Promise<SessionResult> {
  const deps = depsInput || (await createSessionDeps({ workspacePath: params.repo }));
  const { name, repo, task, branch: inputBranch, noStatusUpdate, quiet, json } = params;
  let repoUrl = repo;

  try {
    log.debug("Starting session with params", {
      name,
      repoUrl,
      task,
      inputBranch,
      noStatusUpdate,
      quiet,
      json,
    });

    const currentDir = process.env.PWD || process.cwd();
    const isInSession = await deps.workspaceUtils.isSessionRepository(currentDir);
    if (isInSession) {
      throw new MinskyError(
        "Cannot create a new session while inside a session workspace. Please return to the main workspace first."
      );
    }

    if (!repoUrl) {
      try {
        log.debug("No repoUrl provided, attempting to resolve from current directory", {
          currentDir,
        });
        repoUrl = await resolveRepoPath({ repo: currentDir });
        log.debug("Resolved repoUrl from current directory", { repoUrl });
      } catch (error) {
        log.warn("Failed to resolve repoUrl from current directory", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!name && !task) {
          throw new ValidationError(
            "Could not determine repository path. Please provide a repository URL or path."
          );
        }
      }
    }

    if (!repoUrl) {
      throw new ValidationError("Repository URL is required");
    }

    log.debug("Using repoUrl", { repoUrl });
    const repoPathToUse = params.repo || (await resolveRepoPath({}));
    log.debug("Resolved repoPathToUse", { repoPathToUse });

    if (!repoPathToUse) {
      throw new MinskyError(
        "Repository path could not be determined. Please specify with --repo or run from within a Git repository."
      );
    }

    const repoName = normalizeRepoName(repoPathToUse);
    const normalizedRepoName = repoName.replace(/[^a-zA-Z0-9-_]/g, "-");
    log.debug("Normalized repo name", { repoName, normalizedRepoName });

    let taskId: string | undefined = undefined;
    let sessionName: string;

    if (task) {
      // First normalize the task ID
      const normalizedTaskId = normalizeAndValidateTaskId(task);

      const taskInfo = await deps.taskService.getTask(normalizedTaskId);

      if (!taskInfo) {
        throw new ResourceNotFoundError(
          `Task not found: ${normalizedTaskId}`,
          "task",
          normalizedTaskId
        );
      }

      taskId = normalizedTaskId;
      sessionName = `task#${normalizedTaskId.replace(/^#/, "")}`;

      const existingSession = await deps.sessionDB.getSessionByTaskId(normalizedTaskId);
      if (existingSession) {
        throw new MinskyError(
          `Session already exists for task ${normalizedTaskId}: ${existingSession.session}`
        );
      }
    } else if (name) {
      sessionName = name;

      const existingSession = await deps.sessionDB.getSession(name);
      if (existingSession) {
        throw new MinskyError(`Session already exists with name: ${name}`);
      }
    } else {
      throw new ValidationError("Either a session name or task ID must be provided");
    }

    const actualBranchName = inputBranch || sessionName;
    log.debug("Using branch name", { actualBranchName });

    const sessionRecord: SessionRecord = {
      session: sessionName,
      repoUrl,
      repoName: normalizedRepoName,
      createdAt: new Date().toISOString(),
      backendType: "local",
      branch: actualBranchName,
      remote: {
        authMethod: "ssh",
        depth: 1,
      },
    };

    if (taskId) {
      sessionRecord.taskId = taskId;
    }

    log.debug("Created session record", { sessionRecord });

    const repoPath = deps.sessionDB.getNewSessionRepoPath(normalizedRepoName, sessionName);
    sessionRecord.repoPath = repoPath;
    log.debug("Session directory path", { repoPath });

    // Ensure the session directory exists before git operations
    await mkdir(repoPath, { recursive: true });
    log.debug("Created session directory");

    await deps.sessionDB.addSession(sessionRecord);
    log.debug("Added session to database");

    const cloneOptions = {
      repoUrl,
      sessionName,
      workdir: repoPath,
      branch: actualBranchName,
      depth: 1,
    };

    log.debug("Starting git clone operation", { cloneOptions });
    try {
      const cloneResult = await deps.gitService.clone({
        ...cloneOptions,
        session: sessionName,
      });
      log.debug("Git clone completed successfully", { cloneResult });
    } catch (error) {
      log.error("Git clone failed", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        cloneOptions,
      });
      throw new MinskyError(
        `Failed to clone repository: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    let statusUpdateResult;
    if (taskId && !noStatusUpdate) {
      try {
        log.debug("Updating task status", { taskId, status: TASK_STATUS.IN_PROGRESS });
        statusUpdateResult = await deps.taskService.setTaskStatus(taskId, TASK_STATUS.IN_PROGRESS);
      } catch (error) {
        log.warn("Warning: Failed to update task status", {
          error: error instanceof Error ? error.message : String(error),
          taskId,
          targetStatus: TASK_STATUS.IN_PROGRESS,
        });
      }
    }

    const branchCmdOptions: BranchOptions = { session: sessionName, branch: actualBranchName };
    log.debug("Starting git branch operation", { branchCmdOptions });

    try {
      const branchResult = await deps.gitService.branch(branchCmdOptions);
      log.debug("Git branch completed successfully", { branchResult });

      return {
        sessionRecord,
        cloneResult: { workdir: repoPath },
        branchResult: { branch: branchResult.branch },
      };
    } catch (error) {
      log.error("Git branch failed", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        branchCmdOptions,
      });
      throw new MinskyError(
        `Failed to create branch: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } catch (error) {
    log.error("Session start failed", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      params,
    });

    if (error instanceof MinskyError) {
      throw error;
    }
    throw new MinskyError(
      `Failed to start session: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Updates an existing session based on parameters
 */
export async function updateSessionFromParams(
  params: SessionUpdateParams,
  depsInput?: SessionDeps
): Promise<SessionRecord | null> {
  const deps =
    depsInput ||
    (await createSessionDeps({
      workspacePath: params.workspace || params.repo || process.cwd(),
    }));
  const { name: sessionName, task: taskParam, branch: inputBranch, remote: inputRemote } = params;
  const sessionDB = deps.sessionDB;

  let sessionNameToUse = sessionName;

  if (params.task && !sessionName) {
    // First normalize the task ID
    const normalizedTaskId = normalizeAndValidateTaskId(params.task);

    const session = await sessionDB.getSessionByTaskId(normalizedTaskId);
    if (!session) {
      throw new ResourceNotFoundError(
        `No session found for task ${normalizedTaskId}`,
        "task",
        normalizedTaskId
      );
    }
    sessionNameToUse = session.session;
  }

  if (!sessionNameToUse) {
    throw new ValidationError("Either session name or task ID must be provided");
  }

  const existingSession = await sessionDB.getSession(sessionNameToUse);
  if (!existingSession) {
    throw new ResourceNotFoundError(
      `Session "${sessionNameToUse}" not found`,
      "session",
      sessionNameToUse
    );
  }

  const sessionWorkDir = await deps.sessionDB.getSessionWorkdir(sessionNameToUse);
  const currentBranch = inputBranch || existingSession.branch || "main";

  if (!params.noStash) {
    await deps.gitService.stashChanges(sessionWorkDir);
  }

  await deps.gitService.pullLatest(sessionWorkDir, inputRemote);
  await deps.gitService.mergeBranch(sessionWorkDir, currentBranch);

  if (!params.noStash) {
    await deps.gitService.popStash(sessionWorkDir);
  }

  if (!params.noPush) {
    await deps.gitService.push({
      session: sessionName,
      repoPath: sessionWorkDir,
      remote: inputRemote,
    });
  }

  const {
    name: _n,
    task: _t,
    noStash,
    noPush,
    repo: _r,
    branch: _b,
    remote: _re,
    ...updatesToApply
  } = params;

  await sessionDB.updateSession(
    sessionNameToUse,
    updatesToApply as Partial<Omit<SessionRecord, "session">>
  );

  return sessionDB.getSession(sessionNameToUse);
}

/**
 * Gets the directory path for a session based on parameters
 */
export async function getSessionDirFromParams(params: SessionDirParams): Promise<string> {
  const { name, task } = params;
  const sessionDB = new SessionDB({ baseDir: params.repo || params.workspace });

  let session: SessionRecord | null = null;

  if (task && !name) {
    // First normalize the task ID
    const normalizedTaskId = normalizeAndValidateTaskId(task);

    session = await sessionDB.getSessionByTaskId(normalizedTaskId);
    if (!session) {
      throw new ResourceNotFoundError(
        `No session found for task ${normalizedTaskId}`,
        "task",
        normalizedTaskId
      );
    }
  } else if (name) {
    session = await sessionDB.getSession(name);
    if (!session) {
      throw new ResourceNotFoundError(`Session "${name}" not found`, "session", name);
    }
  } else {
    throw new ResourceNotFoundError("You must provide either a session name or task ID");
  }

  return await sessionDB.getRepoPath(session);
}

/**
 * Deletes a session based on parameters
 */
export async function deleteSessionFromParams(params: SessionDeleteParams): Promise<boolean> {
  const { name, force } = params;
  const sessionDB = new SessionDB({ baseDir: params.repo || params.workspace });

  if (!name) {
    throw new ValidationError("Session name must be provided");
  }

  const existingSession = await sessionDB.getSession(name);
  if (!existingSession) {
    throw new ResourceNotFoundError(`Session "${name}" not found`, "session", name);
  }

  return sessionDB.deleteSession(name);
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
  depsInput?: SessionDeps
): Promise<{
  session: string;
  commitHash: string;
  mergeDate: string;
  mergedBy: string;
  baseBranch: string;
  prBranch: string;
  taskId?: string;
}> {
  const deps =
    depsInput ||
    (await createSessionDeps({
      workspacePath: params.repo || process.cwd(),
    }));

  log.debug("Session approve called with params", params);

  let sessionNameToUse = params.session;
  let taskId: string | undefined;

  // Try to get session from task ID if provided
  if (params.task && !sessionNameToUse) {
    const normalizedTaskId = normalizeAndValidateTaskId(params.task);
    taskId = normalizedTaskId;

    const session = await deps.sessionDB.getSessionByTaskId(normalizedTaskId);
    if (!session) {
      throw new ResourceNotFoundError(
        `No session found for task ${normalizedTaskId}`,
        "task",
        normalizedTaskId
      );
    }
    sessionNameToUse = session.session;
    log.debug("Using session from task ID", {
      taskId: normalizedTaskId,
      session: sessionNameToUse,
    });
  }

  // If session is still not set, try to detect it from repo path
  if (!sessionNameToUse && params.repo) {
    const sessionContext = await deps.workspaceUtils.getCurrentSessionContext(params.repo);
    if (sessionContext) {
      sessionNameToUse = sessionContext.sessionId;
      taskId = sessionContext.taskId;
      log.debug("Using detected session from repo path", { session: sessionNameToUse, taskId });
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
    log.debug("Using task ID from session record", { taskId });
  }

  // Get session workdir
  const sessionWorkdir = await deps.sessionDB.getSessionWorkdir(sessionNameToUse);
  log.debug("Session workdir", { sessionWorkdir });

  // Determine PR branch name (pr/<session-name>)
  const featureBranch = sessionNameToUse;
  const prBranch = `pr/${featureBranch}`;
  const baseBranch = "main"; // Default base branch, could be made configurable

  log.debug("Merging PR branch", { prBranch, baseBranch, workdir: sessionWorkdir });

  try {
    // Execute git commands to merge the PR branch
    // First, check out the base branch
    await deps.gitService.execInRepository(sessionWorkdir, `git checkout ${baseBranch}`);
    // Fetch latest changes
    await deps.gitService.execInRepository(sessionWorkdir, `git fetch origin`);
    // Perform the fast-forward merge
    await deps.gitService.execInRepository(
      sessionWorkdir,
      `git merge --ff-only origin/${prBranch}`
    );

    // Get commit hash and date
    const commitHash = (
      await deps.gitService.execInRepository(sessionWorkdir, `git rev-parse HEAD`)
    ).trim();
    const mergeDate = new Date().toISOString();
    const mergedBy = (
      await deps.gitService.execInRepository(sessionWorkdir, `git config user.name`)
    ).trim();

    // Push the changes
    await deps.gitService.execInRepository(sessionWorkdir, `git push origin ${baseBranch}`);
    // Delete the PR branch
    await deps.gitService.execInRepository(sessionWorkdir, `git push origin --delete ${prBranch}`);

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

    // Update task metadata and status if we have a task ID
    if (taskId) {
      try {
        // Update task metadata - we need to use the task backend directly
        const taskBackend = await deps.taskService.getBackendForTask(taskId);
        if (taskBackend && typeof taskBackend.setTaskMetadata === "function") {
          await taskBackend.setTaskMetadata(taskId, mergeInfo);
        }

        // Update task status to DONE
        await deps.taskService.setTaskStatus(taskId, "DONE");

        log.debug("Updated task metadata and status", { taskId, status: "DONE", mergeInfo });
      } catch (error) {
        // Don't fail the whole operation if task update fails
        log.warn("Warning: Failed to update task status or metadata", {
          error: error instanceof Error ? error.message : String(error),
          taskId,
          targetStatus: "DONE",
          mergeInfo,
        });
      }
    }

    return mergeInfo;
  } catch (error) {
    log.error("Session approve failed", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      params,
    });

    if (error instanceof MinskyError) {
      throw error;
    }

    throw new MinskyError(
      `Failed to approve session: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

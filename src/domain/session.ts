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

<<<<<<< HEAD
  constructor(options?: { dbPath?: string; baseDir?: string }) {
=======
  constructor(options?: { baseDir?: string; dbPath?: string }) {
>>>>>>> origin/main
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
        dbPath: this.dbPath
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
      const normalizedInputId = normalizeTaskId(taskId);
      if (!normalizedInputId) {
        return null;
      }
      const sessions = await this.readDb();
      const found = sessions.find((s) => {
        if (!s.taskId) return false;
        const normalizedStoredId = normalizeTaskId(s.taskId);
        return normalizedStoredId === normalizedInputId;
      });
      return found || null;
    } catch (error) {
      log.error("Error finding session by task ID", {
          error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
          taskId
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
        session 
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

export function createSessionDeps(options?: { workspacePath?: string }): SessionDeps {
  const baseDir = options?.workspacePath || process.cwd();
  const sessionDBInstance = new SessionDB({ baseDir });
  const gitServiceInstance = new GitService(baseDir);
  const taskServiceInstance = new TaskService({
    workspacePath: baseDir,
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
<<<<<<< HEAD
  const { name, task } = params;
  const sessionDB = new SessionDB({ baseDir: params.repo || params.workspace });
=======
  const { name, task, dbPath } = params as any; // allow dbPath for test injection
  const sessionDB = new SessionDB({ baseDir: params.repo || params.workspacePath, dbPath });
>>>>>>> origin/main
  if (task && !name) {
    const normalizedTaskId = taskIdSchema.parse(task);
    return sessionDB.getSessionByTaskId(normalizedTaskId);
  }
  if (name) {
    return sessionDB.getSession(name);
  }
  throw new ResourceNotFoundError("You must provide either a session name or task ID");
}

/**
 * Lists all sessions based on parameters
 */
export async function listSessionsFromParams(params: SessionListParams): Promise<Session[]> {
<<<<<<< HEAD
  const sessionDB = new SessionDB({ baseDir: params.repo || params.workspace });
=======
  const { dbPath } = params as any;
  const sessionDB = new SessionDB({ baseDir: params.repo || params.workspacePath, dbPath });
>>>>>>> origin/main
  return sessionDB.listSessions();
}

/**
 * Starts a new session based on parameters
 */
export async function startSessionFromParams(
  params: SessionStartParams,
  deps = createSessionDeps({ workspacePath: params.repo })
): Promise<SessionResult> {
  const { name, repo, task, branch: inputBranch, noStatusUpdate, quiet, json } = params;
  let repoUrl = repo;

  try {
    const currentDir = process.env.PWD || process.cwd();
    const isInSession = await deps.workspaceUtils.isSessionRepository(currentDir);
    if (isInSession) {
      throw new MinskyError(
        "Cannot create a new session while inside a session workspace. Please return to the main workspace first."
      );
    }

    if (!repoUrl) {
      try {
        repoUrl = await resolveRepoPath({ repo: currentDir });
      } catch (error) {
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

    const repoName = normalizeRepoName(repoUrl);
    const normalizedRepoName = repoName.replace(/[^a-zA-Z0-9-_]/g, "-");

    let taskId: string | undefined = undefined;
    let sessionName: string;

    if (task) {
      const normalizedTaskId = taskIdSchema.parse(task);
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

    const sessionRecord: SessionRecord = {
      session: sessionName,
      repoUrl,
      repoName: normalizedRepoName,
      createdAt: new Date().toISOString(),
      backendType: "local",
      remote: {
        authMethod: "ssh",
        depth: 1,
      },
    };

    if (taskId) {
      sessionRecord.taskId = taskId;
    }

    const repoPath = deps.sessionDB.getNewSessionRepoPath(normalizedRepoName, sessionName);
    sessionRecord.repoPath = repoPath;

    await deps.sessionDB.addSession(sessionRecord);

    const cloneOptions = {
      repoUrl,
      sessionName,
      workdir: repoPath,
      branch: actualBranchName,
      depth: 1,
    };

    const cloneResult = await deps.gitService.clone(cloneOptions);

    let statusUpdateResult;
    if (taskId && !noStatusUpdate) {
      try {
        statusUpdateResult = await deps.taskService.setTaskStatus(taskId, TASK_STATUS.IN_PROGRESS);
      } catch (error) {
<<<<<<< HEAD
        log.warn("Warning: Failed to update task status", { 
          error: error instanceof Error ? error.message : String(error),
          taskId,
          targetStatus: TASK_STATUS.IN_PROGRESS
        });
=======
        console.warn(
          `Warning: Failed to update task status: ${error instanceof Error ? error.message : String(error)}`
        );
>>>>>>> origin/main
      }
    }

    const branchCmdOptions: BranchOptions = { session: sessionName, branch: actualBranchName };
    const branchResult = await deps.gitService.branch(branchCmdOptions);

    return {
      sessionRecord,
      cloneResult,
      branchResult: { branch: branchResult.branch },
    };
  } catch (error) {
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
  deps = createSessionDeps({ workspacePath: params.repo })
): Promise<SessionRecord | null> {
  const { name, task, branch: inputBranch, remote: inputRemote } = params;
  const sessionDB = deps.sessionDB;

  let sessionName = name;

  if (task && !name) {
    const normalizedTaskId = taskIdSchema.parse(task);
    const session = await sessionDB.getSessionByTaskId(normalizedTaskId);
    if (!session) {
      throw new ResourceNotFoundError(
        `No session found for task ${normalizedTaskId}`,
        "task",
        normalizedTaskId
      );
    }
    sessionName = session.session;
  }

  if (!sessionName) {
    throw new ValidationError("Either session name or task ID must be provided");
  }

  const existingSession = await sessionDB.getSession(sessionName);
  if (!existingSession) {
    throw new ResourceNotFoundError(`Session "${sessionName}" not found`, "session", sessionName);
  }

  const sessionWorkDir = await deps.sessionDB.getSessionWorkdir(sessionName);
  const currentBranch = inputBranch || existingSession.branch || "main";

  if (!params.noStash) {
    await deps.gitService.stashChanges(sessionWorkDir);
  }

  // Adjust method calls to match the expected signatures
  await deps.gitService.pullLatest(sessionWorkDir, inputRemote);
  await deps.gitService.mergeBranch(sessionWorkDir, currentBranch);

  if (!params.noStash) {
    await deps.gitService.popStash(sessionWorkDir);
  }

  if (!params.noPush) {
    await deps.gitService.push({
      repoPath: sessionWorkDir,
      remote: inputRemote
    });
  }

  const {
    name: _n,
    task: _t,
    noStash,
    noPush,
    repo,
    branch,
    remote,
    ...updatesToApply
  } = params;

  await sessionDB.updateSession(
    sessionName,
    updatesToApply as Partial<Omit<SessionRecord, "session">>
  );

  return sessionDB.getSession(sessionName);
}

/**
 * Gets the directory path for a session based on parameters
 */
export async function getSessionDirFromParams(params: SessionDirParams): Promise<string> {
<<<<<<< HEAD
  const { name, task } = params;
  const sessionDB = new SessionDB({ baseDir: params.repo || params.workspace });
=======
  const { name, task, dbPath } = params as any;
  const sessionDB = new SessionDB({ baseDir: params.repo || params.workspacePath, dbPath });
>>>>>>> origin/main

  let session: SessionRecord | null = null;

  if (task && !name) {
    const normalizedTaskId = taskIdSchema.parse(task);
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

  return sessionDB.getRepoPath(session);
}

/**
 * Deletes a session based on parameters
 */
export async function deleteSessionFromParams(params: SessionDeleteParams): Promise<boolean> {
<<<<<<< HEAD
  const { name, force } = params;
  const sessionDB = new SessionDB({ baseDir: params.repo || params.workspace });
=======
  const { name, force, dbPath } = params as any;
  const sessionDB = new SessionDB({ baseDir: params.repo || params.workspacePath, dbPath });
>>>>>>> origin/main

  if (!name) {
    throw new ValidationError("Session name must be provided");
  }

  const existingSession = await sessionDB.getSession(name);
  if (!existingSession) {
    throw new ResourceNotFoundError(`Session "${name}" not found`, "session", name);
  }

  return sessionDB.deleteSession(name);
}

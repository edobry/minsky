/// <reference types="@bun-types" />
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
      console.log(`[DEBUG] Starting writeDb. DB Path: ${this.dbPath}`);
      await this.ensureDbDir();
      console.log("[DEBUG] DB directory ensured.");
      await writeFile(this.dbPath, JSON.stringify(sessions, null, 2));
      console.log("[DEBUG] DB file written successfully.");
    } catch (error) {
      console.error(
        `[DEBUG] Error writing session database: ${error instanceof Error ? error.message : String(error)}`
      );
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
        ...updates 
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
      console.error(
        `Error finding session by task ID: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  async deleteSession(session: string): Promise<boolean> {
    try {
      const sessions = await this.readDb();
      const index = sessions.findIndex((s) => s.session === session);
      if (index === -1) {
        console.log(`[DEBUG] Session '${session}' not found in DB.`);
        return false;
      }
      console.log(`[DEBUG] Found session '${session}' at index ${index}.`);
      sessions.splice(index, 1);
      console.log(`[DEBUG] Session '${session}' removed from array.`);
      await this.writeDb(sessions);
      console.log(`[DEBUG] writeDb called for session '${session}'.`);
      return true;
    } catch (error) {
      console.error(
        `[DEBUG] Error in deleteSession for '${session}': ${error instanceof Error ? error.message : String(error)}`
      );
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

export const createSessionDeps = (options?: { workspacePath?: string }): SessionDeps => {
  const baseDir = options?.workspacePath || WorkspaceUtils.resolveWorkspacePath({});
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
};

/**
 * Gets session details based on parameters
 */
export async function getSessionFromParams(params: SessionGetParams): Promise<Session | null> {
  const { name, task } = params;
  const sessionDB = new SessionDB({ baseDir: params.repo || params.workspacePath });
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
  const sessionDB = new SessionDB({ baseDir: params.repo || params.workspacePath });
  return sessionDB.listSessions();
}

/**
 * Starts a new session based on parameters
 */
export async function startSessionFromParams(
  params: SessionStartParams,
  deps: SessionDeps = createSessionDeps({ workspacePath: params.repo })
): Promise<SessionResult> {
  const { name, repo, task, branch: inputBranch, noStatusUpdate, quiet, json } = params;
  let repoUrl = repo;

  try {
    const currentDir = Bun.env.PWD || process.cwd();
    const isInSession = await deps.workspaceUtils.isSessionRepository(currentDir);
    if (isInSession) {
      throw new MinskyError(
        "Cannot create a new session while inside a session workspace. Please return to the main workspace first."
      );
    }

    if (!repoUrl) {
      try {
        repoUrl = await WorkspaceUtils.resolveRepoPath({ repo: currentDir });
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
        throw new ResourceNotFoundError(`Task not found: ${normalizedTaskId}`, "task", normalizedTaskId);
      }

      taskId = normalizedTaskId;
      sessionName = `task#${normalizedTaskId.replace(/^#/, "")}`;

      const existingSession = await deps.sessionDB.getSessionByTaskId(normalizedTaskId);
      if (existingSession) {
        throw new MinskyError(`Session already exists for task ${normalizedTaskId}: ${existingSession.session}`);
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

    const cloneOptions: GitOptions = {
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
        console.warn(`Warning: Failed to update task status: ${error instanceof Error ? error.message : String(error)}`);
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
  deps: SessionDeps = createSessionDeps({
    workspacePath: params.workspacePath || params.repo || WorkspaceUtils.resolveWorkspacePath({}),
  })
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
    await deps.gitService.stashChanges({ sessionWorkDir });
  }

  await deps.gitService.pullLatest({ sessionWorkDir, remote: inputRemote, branch: currentBranch });
  await deps.gitService.mergeBranch({ sessionWorkDir, branchToMerge: currentBranch });

  if (!params.noStash) {
    await deps.gitService.popStash({ sessionWorkDir });
  }

  if (!params.noPush) {
    await deps.gitService.pushBranch({
      sessionWorkDir,
      remote: inputRemote,
      branch: currentBranch,
    });
  }

  const {
    name: _n,
    task: _t,
    noStash,
    noPush,
    workspacePath,
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
  const { name, task } = params;
  const sessionDB = new SessionDB({ baseDir: params.repo || params.workspacePath });

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
  const { name, force } = params;
  const sessionDB = new SessionDB({ baseDir: params.repo || params.workspacePath });

  if (!name) {
    throw new ValidationError("Session name must be provided");
  }

  const existingSession = await sessionDB.getSession(name);
  if (!existingSession) {
    throw new ResourceNotFoundError(`Session "${name}" not found`, "session", name);
  }

  return sessionDB.deleteSession(name);
}

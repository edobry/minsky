/// <reference types="@bun-types" />
import { join } from "path";
import { readFile, writeFile, mkdir, access, rename } from "fs/promises";
import { existsSync } from "fs";
import { normalizeRepoName } from "./repo-utils.js";
import { existsSync as syncExists, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
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
import * as WorkspaceUtils from "../utils/workspace.js"; // Verified path
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

  constructor(options?: { baseDir?: string }) {
    const xdgStateHome = Bun.env.XDG_STATE_HOME || join(Bun.env.HOME || "", ".local/state");
    this.baseDir = options?.baseDir || join(xdgStateHome, "minsky");
    this.dbPath = join(this.baseDir, "minsky", "session-db.json");
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
          console.error(`Failed to migrate session ${session.session}:`, err);
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

const defaultDeps = {
  SessionDB, 
  GitService,
  TaskService,
  WorkspaceUtils,
};

export const createSessionDeps = (options?: { workspacePath?: string }): SessionDeps => {
  const baseDir = options?.workspacePath || WorkspaceUtils.resolveWorkspacePath(options || {});
  const sessionDBInstance = new defaultDeps.SessionDB({ baseDir });
  
  const gitServiceInstance = new defaultDeps.GitService(baseDir);
  
  const taskServiceInstance = new defaultDeps.TaskService({
    workspacePath: baseDir, 
    backend: "markdown", 
  });

  return {
    sessionDB: sessionDBInstance,
    gitService: gitServiceInstance,
    taskService: taskServiceInstance,
    workspaceUtils: defaultDeps.WorkspaceUtils,
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
        repoUrl = await WorkspaceUtils.resolveRepoPath({}); 
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        throw new MinskyError(
          `--repo is required (not in a git repo and no --repo provided): ${error.message}`
        );
      }
    }
    
    let sessionName = name;
    let effectiveTaskId: string | undefined = task;

    if (effectiveTaskId && !sessionName) {
      const normalizedTaskId = taskIdSchema.parse(effectiveTaskId);
      effectiveTaskId = normalizedTaskId;
      const taskObj = await deps.taskService.getTask(effectiveTaskId);
      if (!taskObj) {
        throw new ResourceNotFoundError(`Task ${effectiveTaskId} not found`, "task", effectiveTaskId);
      }
      sessionName = `task${effectiveTaskId}`;
    }

    if (!sessionName) {
      throw new ValidationError("Either session name or task ID must be provided");
    }

    const existingSession = await deps.sessionDB.getSession(sessionName);
    if (existingSession) {
      throw new MinskyError(`Session "${sessionName}" already exists.`);
    }

    const repoName = normalizeRepoName(repoUrl); 
    const destinationPath = deps.sessionDB.getNewSessionRepoPath(repoName, sessionName);

    const cloneResult = await deps.gitService.clone({
      repoUrl: repoUrl, 
      destination: destinationPath,
      branch: inputBranch,
    });

    const repoPath = cloneResult.workdir;
    const actualBranchName = inputBranch || sessionName; 

    const sessionRecord: SessionRecord = {
      session: sessionName,
      repoName,
      repoUrl,
      createdAt: new Date().toISOString(),
      taskId: effectiveTaskId,
      repoPath,
      branch: actualBranchName, 
    };

    await deps.sessionDB.addSession(sessionRecord);
    
    const branchCmdOptions: BranchOptions = { session: sessionName, branch: actualBranchName };
    if (repoPath) {
        // branchCmdOptions.workDir = repoPath; // Example if workDir was valid
    }
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
  deps: SessionDeps = createSessionDeps({ workspacePath: params.workspacePath || params.repo || WorkspaceUtils.resolveWorkspacePath({}) })
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
  const currentBranch = inputBranch || existingSession.branch || 'main';

  if (!params.noStash) {
    await deps.gitService.stashChanges({ sessionWorkDir });
  }
  
  await deps.gitService.pullLatest({ sessionWorkDir, remote: inputRemote, branch: currentBranch });
  await deps.gitService.mergeBranch({ sessionWorkDir, branchToMerge: currentBranch });

  if (!params.noStash) {
    await deps.gitService.popStash({ sessionWorkDir });
  }

  if (!params.noPush) {
    await deps.gitService.pushBranch({ sessionWorkDir, remote: inputRemote, branch: currentBranch });
  }

  const { name: _n, task: _t, noStash, noPush, workspacePath, repo, branch, remote, ...updatesToApply } = params;
  
  await sessionDB.updateSession(sessionName, updatesToApply as Partial<Omit<SessionRecord, "session">>);

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

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
import { GitService } from "./git.js";
import { TaskService, TASK_STATUS } from "./tasks.js";
import { isSessionRepository } from "./workspace.js";
import { resolveRepoPath } from "./repo-utils.js";
import { getCurrentSession } from "./workspace.js";
import { normalizeTaskId } from "./tasks/utils.js";

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
  branch?: string;
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

// Interface for GitService.clone result
interface CloneResult {
  repoPath: string;
  success: boolean;
  message?: string;
}

/**
 * In-memory cache of session database
 */
const sessionDbCache: Session[] | null = null;

/**
 * Session database operations
 */
export class SessionDB {
  private readonly dbPath: string;
  private readonly baseDir: string; // Add baseDir property

  constructor(dbPath?: string) {
    const xdgStateHome = Bun.env.XDG_STATE_HOME || join(Bun.env.HOME || "", ".local/state");

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
      console.error(
        `Error writing session database: ${error instanceof Error ? error.message : String(error)}`
      );
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
      if (!taskId) {
        return null;
      }

      // Normalize the input task ID
      const normalizedInputId = normalizeTaskId(taskId);
      if (!normalizedInputId) {
        return null; // Invalid task ID format
      }

      const sessions = await this.readDb();
      // Find a session with a matching task ID (also normalize stored task IDs)
      const found = sessions.find((s) => {
        if (!s.taskId) return false;
        const normalizedStoredId = normalizeTaskId(s.taskId);
        return normalizedStoredId === normalizedInputId;
      });

      return found || null; // Ensure we return null, not undefined
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
        return false;
      }
      sessions.splice(index, 1);
      await this.writeDb(sessions);
      return true;
    } catch (error) {
      console.error(
        `Error deleting session: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  /**
   * Get the repository path for a session, checking both legacy and new paths
   * @param record The session record
   * @returns The repository path
   */
  async getRepoPath(record: SessionRecord): Promise<string> {
    // Check for new path first (with sessions subdirectory)
    const newPath = join(this.baseDir, record.repoName, "sessions", record.session);
    const legacyPath = join(this.baseDir, record.repoName, record.session);

    // If the record already has a repoPath, use that
    if (record.repoPath) {
      return record.repoPath;
    }

    // Check if the sessions subdirectory structure exists
    if (await this.repoExists(newPath)) {
      return newPath;
    }

    // Fall back to legacy path
    if (await this.repoExists(legacyPath)) {
      return legacyPath;
    }

    // Default to new path structure even if it doesn"t exist yet
    return newPath;
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
      if (session.repoPath && session.repoPath.includes("/sessions/")) {
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
          console.error(`Failed to migrate session ${session.session}:`, err);
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
 */
export async function getSessionFromParams(params: SessionGetParams): Promise<Session | null> {
  const { name, task } = params;

  // If task is provided but no name, find session by task ID
  if (task && !name) {
    const normalizedTaskId = taskIdSchema.parse(task);
    return new SessionDB().getSessionByTaskId(normalizedTaskId);
  }

  // If name is provided, get by name
  if (name) {
    return new SessionDB().getSession(name);
  }

  // No name or task - error case
  throw new ResourceNotFoundError("You must provide either a session name or task ID");
}

/**
 * Lists all sessions based on parameters
 */
export async function listSessionsFromParams(params: SessionListParams): Promise<Session[]> {
  return new SessionDB().listSessions();
}

/**
 * Starts a new session based on parameters
 */
export async function startSessionFromParams(params: SessionStartParams): Promise<Session> {
  // Validate parameters using Zod schema (already done by type)
  const { name, repo, task, branch, noStatusUpdate, quiet, json } = params;

  // Convert dependencies for dependency injection pattern
  const deps = {
    gitService: new GitService(),
    sessionDB: new SessionDB(),
    taskService: null as TaskService | null,
    resolveRepoPath,
    isSessionRepository,
  };

  try {
    // Check if current directory is already within a session workspace
    // eslint-disable-next-line no-restricted-globals
    const currentDir = Bun.env.PWD || process.cwd();
    const isInSession = await deps.isSessionRepository(currentDir);
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

    // Initialize task service with the repository information
    deps.taskService = new TaskService({
      workspacePath: repoUrl,
      backend: "markdown", // Default to markdown backend
    });

    // Determine the session name using task ID if provided
    let sessionName = name;
    let taskId: string | undefined = task;

    if (taskId && !sessionName) {
      // Normalize the task ID format using Zod validation
      const normalizedTaskId = taskIdSchema.parse(taskId);
      taskId = normalizedTaskId;

      // Verify the task exists
      const taskObj = await deps.taskService.getTask(taskId);
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
      throw new MinskyError(`Session "${sessionName}" already exists.`);
    }

    // Normalize the repository name (for filesystem-safe naming)
    const repoName = normalizeRepoName(repoUrl);

    // Clone the repository
    const cloneResult = await deps.gitService.clone({
      repoUrl: repoUrl,
      destination: deps.sessionDB.getNewSessionRepoPath(repoName, sessionName),
      branch,
    });

    // Get the repository path from the clone result
    const repoPath = cloneResult.workdir;

    // Create a session record
    const sessionRecord: SessionRecord = {
      session: sessionName,
      repoName,
      repoUrl,
      createdAt: new Date().toISOString(),
      taskId,
      repoPath,
      branch,
    };

    // Add the session to the database
    await deps.sessionDB.addSession(sessionRecord);

    // Return the created session
    return sessionRecord;
  } catch (error) {
    // Re-throw as MinskyError with appropriate message
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
  params: SessionUpdateParams
): Promise<Session | null> {
  const { name, task } = params;
  const sessionDB = new SessionDB();

  let sessionName = name;

  // If task is provided but no name, find session by task ID
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

  // Verify the session exists
  const existingSession = await sessionDB.getSession(sessionName);
  if (!existingSession) {
    throw new ResourceNotFoundError(`Session "${sessionName}" not found`, "session", sessionName);
  }

  // Extract updatable properties from params
  const { name: _, task: __, ...updates } = params;

  // Update the session
  await sessionDB.updateSession(sessionName, updates as Partial<Omit<SessionRecord, "session">>);

  // Return the updated session
  return sessionDB.getSession(sessionName);
}

/**
 * Gets the directory path for a session based on parameters
 */
export async function getSessionDirFromParams(params: SessionDirParams): Promise<string> {
  const { name, task } = params;
  const sessionDB = new SessionDB();

  let session: SessionRecord | null = null;

  // If task is provided but no name, find session by task ID
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
    // If name is provided, get by name
    session = await sessionDB.getSession(name);
    if (!session) {
      throw new ResourceNotFoundError(`Session "${name}" not found`, "session", name);
    }
  } else {
    // No name or task - error case
    throw new ResourceNotFoundError("You must provide either a session name or task ID");
  }

  // Get the repository path for the session
  return sessionDB.getRepoPath(session);
}

/**
 * Deletes a session based on parameters
 */
export async function deleteSessionFromParams(params: SessionDeleteParams): Promise<boolean> {
  const { name, force } = params;
  const sessionDB = new SessionDB();

  if (!name) {
    throw new ValidationError("Session name must be provided");
  }

  // Verify the session exists
  const existingSession = await sessionDB.getSession(name);
  if (!existingSession) {
    throw new ResourceNotFoundError(`Session "${name}" not found`, "session", name);
  }

  // Delete the session from the database
  return sessionDB.deleteSession(name);
}

import { join } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { normalizeRepoName } from "./repo-utils.js";
import { existsSync as syncExists, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { getStateDir } from "../utils/repo.js";
import type { Session } from "../types/session.js";
import { MinskyError, ResourceNotFoundError } from "../errors/index.js";
import { taskIdSchema } from "../schemas/common.js";
import { 
  SessionListParams, 
  SessionGetParams, 
  SessionStartParams,
  SessionDeleteParams,
  SessionDirParams,
  SessionUpdateParams 
} from "../schemas/session.js";

export interface SessionRecord {
  session: string;
  repoName: string;
  repoUrl: string;
  createdAt: string;
  taskId?: string;
}

export interface Session {
  session: string;
  repoUrl?: string;
  repoName?: string;
  branch?: string;
  createdAt?: string;
  taskId?: string;
  repoPath?: string;
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

  constructor(dbPath?: string) {
    if (dbPath) {
      this.dbPath = dbPath;
    } else {
      const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
      this.dbPath = join(xdgStateHome, "minsky", "session-db.json");
    }
  }

  private async ensureDbDir(): Promise<void> {
    const dbDir = join(this.dbPath, "..");
    await mkdir(dbDir, { recursive: true });
  }

  private async readDb(): Promise<SessionRecord[]> {
    if (!existsSync(this.dbPath)) {
      return [];
    }
    const data = await readFile(this.dbPath, "utf8");
    const sessions = JSON.parse(data);
    // Migrate existing sessions to include repoName
    return sessions.map((session: SessionRecord) => {
      if (!session.repoName) {
        session.repoName = normalizeRepoName(session.repoUrl);
      }
      return session;
    });
  }

  private async writeDb(sessions: SessionRecord[]): Promise<void> {
    await this.ensureDbDir();
    await writeFile(this.dbPath, JSON.stringify(sessions, null, 2));
  }

  async addSession(record: SessionRecord): Promise<void> {
    const sessions = await this.readDb();
    sessions.push(record);
    await this.writeDb(sessions);
  }

  async getSession(session: string): Promise<SessionRecord | null> {
    const sessions = await this.readDb();
    return sessions.find(s => s.session === session) || null;
  }

  async getSessionByTaskId(taskId: string): Promise<SessionRecord | null> {
    // Normalize both stored and input task IDs to allow matching with or without #
    const normalize = (id: string | undefined) => {
      if (!id) return undefined;
      return id.startsWith("#") ? id : `#${id}`;
    };
    const sessions = await this.readDb();
    const normalizedInput = normalize(taskId);
    return sessions.find(s => normalize(s.taskId) === normalizedInput) || null;
  }

  async listSessions(): Promise<SessionRecord[]> {
    return this.readDb();
  }

  async updateSession(session: string, updates: Partial<Omit<SessionRecord, "session">>): Promise<void> {
    const sessions = await this.readDb();
    const index = sessions.findIndex(s => s.session === session);
    if (index !== -1) {
      const { session: _, ...safeUpdates } = updates as any;
      sessions[index] = { ...sessions[index], ...safeUpdates };
      await this.writeDb(sessions);
    }
  }

  async deleteSession(session: string): Promise<boolean> {
    const sessions = await this.readDb();
    const index = sessions.findIndex(s => s.session === session);
    if (index === -1) {
      return false;
    }
    sessions.splice(index, 1);
    await this.writeDb(sessions);
    return true;
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
  // This function will be implemented to call existing startSession logic
  // with proper parameter validation
  throw new MinskyError("Not implemented yet");
}

/**
 * Deletes a session based on parameters
 */
export async function deleteSessionFromParams(params: SessionDeleteParams): Promise<boolean> {
  const { name, task } = params;
  
  if (task && !name) {
    // Find session by task ID
    const normalizedTaskId = taskIdSchema.parse(task);
    const session = await new SessionDB().getSessionByTaskId(normalizedTaskId);
    
    if (!session) {
      throw new ResourceNotFoundError(`No session found for task ID "${normalizedTaskId}"`);
    }
    
    // Delete by name
    return new SessionDB().deleteSession(session.session);
  }
  
  if (!name) {
    throw new ResourceNotFoundError("You must provide either a session name or task ID");
  }
  
  return new SessionDB().deleteSession(name);
}

/**
 * Gets session directory based on parameters
 */
export async function getSessionDirFromParams(params: SessionDirParams): Promise<string> {
  let sessionName: string;
  
  if (params.task && !params.name) {
    // Find session by task ID
    const normalizedTaskId = taskIdSchema.parse(params.task);
    const session = await new SessionDB().getSessionByTaskId(normalizedTaskId);
    
    if (!session) {
      throw new ResourceNotFoundError(`No session found for task ID "${normalizedTaskId}"`);
    }
    
    sessionName = session.session;
  } else if (params.name) {
    sessionName = params.name;
  } else {
    throw new ResourceNotFoundError("You must provide either a session name or task ID");
  }
  
  const session = await new SessionDB().getSession(sessionName);
  
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
 * Updates a session based on parameters
 */
export async function updateSessionFromParams(params: SessionUpdateParams): Promise<void> {
  // This function will be implemented to call existing updateSession logic
  // with proper parameter validation
  throw new MinskyError("Not implemented yet");
}

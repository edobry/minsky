import { join } from "path";
import { promises as fs } from "fs";
import { normalizeRepoName } from "./repo-utils";
import { normalizeTaskId } from "../utils/task-utils";

export interface SessionRecord {
  session: string;
  repoUrl: string;
  repoName: string;
  branch?: string;
  createdAt: string;
  taskId?: string;
  repoPath?: string;
}

export class SessionDB {
  private readonly dbPath: string;
  readonly baseDir: string;

  constructor() {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
    this.dbPath = join(xdgStateHome, "minsky", "session-db.json");
    this.baseDir = join(xdgStateHome, "minsky", "git");
  }

  private async readDb(): Promise<SessionRecord[]> {
    try {
      const data = await fs.readFile(this.dbPath, "utf-8");
      const sessions = JSON.parse(data);
      // Migrate existing sessions to include repoName
      return sessions.map((session: SessionRecord) => {
        if (!session.repoName) {
          session.repoName = normalizeRepoName(session.repoUrl);
        }
        return session;
      });
    } catch (e) {
      // If the file doesn"t exist or can"t be read, return an empty array
      return [];
    }
  }

  private async writeDb(sessions: SessionRecord[]): Promise<void> {
    await fs.mkdir(join(this.dbPath, ".."), { recursive: true });
    await fs.writeFile(this.dbPath, JSON.stringify(sessions, null, 2), "utf-8");
  }

  async addSession(record: SessionRecord): Promise<void> {
    const sessions = await this.readDb();
    // Ensure repoName is set
    record.repoName = record.repoName || normalizeRepoName(record.repoUrl);
    // Normalize taskId if present
    if (record.taskId) {
      record.taskId = normalizeTaskId(record.taskId);
    }
    sessions.push(record);
    await this.writeDb(sessions);
  }

  async listSessions(): Promise<SessionRecord[]> {
    return this.readDb();
  }

  async getSession(session: string): Promise<SessionRecord | undefined> {
    const sessions = await this.readDb();
    return sessions.find(s => s.session === session);
  }

  async updateSession(session: string, update: Partial<Omit<SessionRecord, "session">>): Promise<void> {
    const sessions = await this.readDb();
    const idx = sessions.findIndex(s => s.session === session);
    if (idx !== -1) {
      const { session: _, ...safeUpdate } = update as any;
      sessions[idx] = { ...sessions[idx], ...safeUpdate };
      await this.writeDb(sessions);
    }
  }

  async getSessionByTaskId(taskId: string): Promise<SessionRecord | undefined> {
    const sessions = await this.readDb();
    const normalizedTaskId = normalizeTaskId(taskId);
    return sessions.find(s => s.taskId === normalizedTaskId);
  }

  async deleteSession(session: string): Promise<boolean> {
    const sessions = await this.readDb();
    const initialLength = sessions.length;
    const filteredSessions = sessions.filter(s => s.session !== session);
    
    if (filteredSessions.length === initialLength) {
      // No session was removed
      return false;
    }
    
    await this.writeDb(filteredSessions);
    return true;
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
    
    // Always prefer the new path if it exists
    const newPathExists = await this.repoExists(newPath);
    if (newPathExists) {
      return newPath;
    }
    
    // Fall back to legacy path
    if (await this.repoExists(legacyPath)) {
      return legacyPath;
    }
    
    // Default to new path structure even if it doesn't exist yet
    return newPath;
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
      // Skip sessions that already have a repoPath
      if (session.repoPath && session.repoPath.includes("/sessions/")) {
        continue;
      }
      
      // Ensure repoName is set
      const repoName = session.repoName || normalizeRepoName(session.repoUrl);
      const legacyPath = join(this.baseDir, repoName, session.session);
      const newPath = join(this.baseDir, repoName, "sessions", session.session);
      
      // Check if legacy path exists
      try {
        await fs.access(legacyPath);
        // Create new path directory structure
        await fs.mkdir(join(this.baseDir, repoName, "sessions"), { recursive: true });
        
        // Move repository to new location
        await fs.rename(legacyPath, newPath);
        // Update session record
        session.repoPath = newPath;
        session.repoName = repoName;
        modified = true;
      } catch (err) {
        // Skip if legacy path doesn"t exist
      }
    }
    
    // Save changes
    if (modified) {
      await this.writeDb(sessions);
    }
  }

  private async repoExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch (err) {
      return false;
    }
  }
} 

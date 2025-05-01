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

  // Alias for readDb to maintain backward compatibility with tests
  async getSessions(): Promise<SessionRecord[]> {
    return this.readDb();
  }

  private async writeDb(sessions: SessionRecord[]): Promise<void> {
    await fs.mkdir(join(this.dbPath, ".."), { recursive: true });
    await fs.writeFile(this.dbPath, JSON.stringify(sessions, null, 2), "utf-8");
  }

  // Alias for writeDb to maintain backward compatibility with tests
  async saveSessions(sessions: SessionRecord[]): Promise<void> {
    return this.writeDb(sessions);
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
  
  /**
   * Find a session by its associated task ID
   * @param taskId The task ID to search for (will be normalized if not already)
   * @returns The session record if found, undefined otherwise
   */
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
    // If the record already has a repoPath, use that
    if (record.repoPath) {
      return record.repoPath;
    }
    
    // Ensure repoName is set
    const repoName = record.repoName || normalizeRepoName(record.repoUrl);
    
    // First check if the legacy path exists (for tests expecting the old path format)
    const legacyPath = join(this.baseDir, repoName, record.session);
    try {
      await fs.access(legacyPath);
      return legacyPath;
    } catch (err) {
      // If legacy path doesn"t exist, use the new path with sessions subdirectory
      return join(this.baseDir, repoName, "sessions", record.session);
    }
  }
  
  /**
   * Get the legacy repository path for a session (without sessions subdirectory)
   * For compatibility with tests
   * @param repoName The repository name
   * @param sessionId The session ID
   * @returns The legacy repository path
   */
  getLegacySessionRepoPath(repoName: string, sessionId: string): string {
    return join(this.baseDir, repoName, sessionId);
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
} 

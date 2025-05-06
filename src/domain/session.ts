import { join } from "path";
<<<<<<< HEAD
import { promises as fs } from "fs";
=======
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
>>>>>>> origin/main
import { normalizeRepoName } from "./repo-utils";

interface SessionRecord {
  session: string;
  repoName: string;
  repoUrl: string;
  createdAt: string;
  taskId?: string;
}

class SessionDB {
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    if (dbPath) {
      this.dbPath = dbPath;
<<<<<<< HEAD
      const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
      this.baseDir = join(xdgStateHome, "minsky", "git");
    } else {
      const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
      this.dbPath = join(xdgStateHome, "minsky", "session-db.json");
      this.baseDir = join(xdgStateHome, "minsky", "git");
    }
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
      return [];
=======
    } else {
      const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
      this.dbPath = join(xdgStateHome, "minsky", "session-db.json");
>>>>>>> origin/main
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
<<<<<<< HEAD
    await fs.mkdir(join(this.dbPath, ".."), { recursive: true });
    await fs.writeFile(this.dbPath, JSON.stringify(sessions, null, 2), "utf-8");
  }

  // Alias for writeDb to maintain backward compatibility with tests
  async saveSessions(sessions: SessionRecord[]): Promise<void> {
    return this.writeDb(sessions);
=======
    await this.ensureDbDir();
    await writeFile(this.dbPath, JSON.stringify(sessions, null, 2));
>>>>>>> origin/main
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
<<<<<<< HEAD
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
=======
    const index = sessions.findIndex(s => s.session === session);
    if (index !== -1) {
      const { session: _, ...safeUpdates } = updates as any;
      sessions[index] = { ...sessions[index], ...safeUpdates };
      await this.writeDb(sessions);
    }
  }
>>>>>>> origin/main

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
<<<<<<< HEAD

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
    
    // Default to new path structure even if it doesn't exist yet
    return newPath;
  }
  
  /**
   * Check if a repository exists at the given path
   * @param path The repository path to check
   * @returns true if the repository exists
   */
  private async repoExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
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
      throw new Error(`Session '${sessionName}' not found.`);
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
    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i];
      if (!session || !session.repoName) continue;
      const legacyPath = join(this.baseDir, session.repoName, session.session);
      const newPath = join(this.baseDir, session.repoName, "sessions", session.session);
      if (await this.repoExists(legacyPath) && !(await this.repoExists(newPath))) {
        Object.assign(session, { repoPath: newPath });
        session.repoPath = newPath;
        modified = true;
      }
    }
    if (modified) {
      await this.writeDb(sessions);
    }
  }
}

export const ActualSessionDB = SessionDB;
export { SessionDB };
export type { SessionRecord }; 
=======
}
>>>>>>> origin/main

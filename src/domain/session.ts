import { join } from "path";
import { readFile, writeFile, mkdir, access, rename } from "fs/promises";
import { existsSync } from "fs";
import { normalizeRepoName } from "./repo-utils.js";

export interface SessionRecord {
  session: string;
  repoName: string;
  repoUrl: string;
  createdAt: string;
  taskId?: string;
  repoPath?: string; // Add repoPath to the interface
}

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

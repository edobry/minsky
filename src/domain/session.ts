import { join } from 'path';
import { promises as fs } from 'fs';
import { normalizeRepoName } from './repo-utils';

export interface SessionRecord {
  session: string;
  repoUrl: string;
  repoName: string;
  repoPath?: string;  // Path to the repository for this session
  branch?: string;
  createdAt: string;
  taskId?: string;
}

export class SessionDB {
  private readonly dbPath: string;
  private readonly baseDir: string;

  constructor() {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || '', '.local/state');
    this.dbPath = join(xdgStateHome, 'minsky', 'session-db.json');
    this.baseDir = join(xdgStateHome, 'minsky', 'git');
  }

  /**
   * Get the legacy repository path (before sessions subdirectory was introduced)
   * @param repoName Normalized repository name
   * @param sessionId Session identifier
   * @returns Path to the repository for this session
   */
  private getLegacyRepoPath(repoName: string, sessionId: string): string {
    return join(this.baseDir, repoName, sessionId);
  }

  /**
   * Get the new repository path with sessions subdirectory
   * @param repoName Normalized repository name
   * @param sessionId Session identifier
   * @returns Path to the repository for this session in the sessions subdirectory
   */
  private getNewRepoPath(repoName: string, sessionId: string): string {
    return join(this.baseDir, repoName, 'sessions', sessionId);
  }

  /**
   * Check if a repository exists at the given path
   * @param path Path to check
   * @returns Promise that resolves to true if repo exists, false otherwise
   */
  private async repoExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get the repository path for a session, checking both legacy and new locations
   * @param repoName Normalized repository name
   * @param sessionId Session identifier
   * @returns Path to the repository for this session
   */
  async getRepoPath(repoName: string, sessionId: string): Promise<string> {
    const normalizedRepoName = normalizeRepoName(repoName);
    
    // First check the new path with sessions subdirectory
    const newPath = this.getNewRepoPath(normalizedRepoName, sessionId);
    if (await this.repoExists(newPath)) {
      return newPath;
    }
    
    // Fall back to legacy path if new path doesn't exist
    return this.getLegacyRepoPath(normalizedRepoName, sessionId);
  }

  /**
   * Get the appropriate repository path for creating a new session
   * @param repoName Normalized repository name
   * @param sessionId Session identifier
   * @returns Path to create the new repository
   */
  async getNewSessionRepoPath(repoName: string, sessionId: string): Promise<string> {
    const normalizedRepoName = normalizeRepoName(repoName);
    
    // Always use the new path structure for new sessions
    const newPath = this.getNewRepoPath(normalizedRepoName, sessionId);
    
    // Ensure the sessions directory exists
    const sessionsDir = join(this.baseDir, normalizedRepoName, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    
    return newPath;
  }

  /**
   * Get all sessions from the database
   * @returns Array of session records
   */
  async getSessions(): Promise<SessionRecord[]> {
    try {
      const data = await fs.readFile(this.dbPath, 'utf-8');
      const sessions = JSON.parse(data) as SessionRecord[];
      
      // Update the repo paths in the loaded records
      const updatedSessions = await Promise.all(sessions.map(async (session: SessionRecord) => {
        if (session.repoName) {
          session.repoPath = await this.getRepoPath(session.repoName, session.session);
        }
        return session;
      }));
      
      return updatedSessions;
    } catch (error) {
      // Create empty database file if it doesn't exist
      await fs.mkdir(join(this.dbPath, '..'), { recursive: true });
      await fs.writeFile(this.dbPath, '[]');
      return [];
    }
  }

  /**
   * Save sessions to the database
   * @param sessions Array of session records to save
   */
  async saveSessions(sessions: SessionRecord[]): Promise<void> {
    // Create directory if it doesn't exist
    await fs.mkdir(join(this.dbPath, '..'), { recursive: true });
    await fs.writeFile(this.dbPath, JSON.stringify(sessions, null, 2));
  }

  /**
   * Add a new session to the database
   * @param session Session record to add
   */
  async addSession(session: SessionRecord): Promise<void> {
    const sessions = await this.getSessions();
    
    // Check if session already exists
    const existingIndex = sessions.findIndex(s => s.session === session.session);
    
    if (existingIndex >= 0) {
      // Update existing session
      sessions[existingIndex] = session;
    } else {
      // Add new session
      sessions.push(session);
    }
    
    await this.saveSessions(sessions);
  }

  /**
   * Get a session by its name
   * @param sessionName Name of the session to retrieve
   * @returns Session record or undefined if not found
   */
  async getSession(sessionName: string): Promise<SessionRecord | undefined> {
    const sessions = await this.getSessions();
    return sessions.find(session => session.session === sessionName);
  }

  /**
   * Update an existing session with new values
   * @param sessionName Name of the session to update
   * @param update Partial session record with fields to update
   */
  async updateSession(sessionName: string, update: Partial<Omit<SessionRecord, 'session'>>): Promise<void> {
    const sessions = await this.getSessions();
    const idx = sessions.findIndex(s => s.session === sessionName);
    
    if (idx !== -1) {
      // Ensure we don't overwrite the session name
      const { session: _, ...safeUpdate } = update as any;
      sessions[idx] = { ...sessions[idx], ...safeUpdate };
      await this.saveSessions(sessions);
    }
  }

  /**
   * Delete a session from the database
   * @param sessionName Name of the session to delete
   * @returns true if session was deleted, false if it wasn't found
   */
  async deleteSession(sessionName: string): Promise<boolean> {
    const sessions = await this.getSessions();
    const initialLength = sessions.length;
    
    const filteredSessions = sessions.filter(session => session.session !== sessionName);
    
    if (filteredSessions.length < initialLength) {
      await this.saveSessions(filteredSessions);
      return true;
    }
    
    return false;
  }

  /**
   * Get the working directory for a session
   * @param sessionName Name of the session
   * @returns Path to the session's working directory
   * @throws Error if session is not found
   */
  async getSessionWorkdir(sessionName: string): Promise<string> {
    const record = await this.getSession(sessionName);
    if (!record) {
      throw new Error(`Session '${sessionName}' not found.`);
    }
    
    if (record.repoPath) {
      return record.repoPath;
    }
    
    if (record.repoName) {
      return await this.getRepoPath(record.repoName, sessionName);
    }
    
    throw new Error(`Session '${sessionName}' has no repository path.`);
  }

  /**
   * Find a session by task ID
   * @param taskId ID of the task to find
   * @returns Session record or undefined if not found
   */
  async getSessionByTaskId(taskId: string): Promise<SessionRecord | undefined> {
    const sessions = await this.getSessions();
    return sessions.find(session => session.taskId === taskId);
  }

  /**
   * List all sessions
   * @returns Array of all session records
   */
  async listSessions(): Promise<SessionRecord[]> {
    return this.getSessions();
  }

  /**
   * Migrate existing session repositories to the new sessions subdirectory structure
   * This method is idempotent and safe to run multiple times
   */
  async migrateSessionsToSubdirectory(): Promise<void> {
    const sessions = await this.getSessions();
    
    for (const session of sessions) {
      if (!session.repoName) {
        continue;
      }
      
      const normalizedRepoName = normalizeRepoName(session.repoName);
      const legacyPath = this.getLegacyRepoPath(normalizedRepoName, session.session);
      const newPath = this.getNewRepoPath(normalizedRepoName, session.session);
      
      // Check if repository exists in the legacy location and not in the new location
      const legacyExists = await this.repoExists(legacyPath);
      const newExists = await this.repoExists(newPath);
      
      if (legacyExists && !newExists) {
        // Create the sessions directory
        const sessionsDir = join(this.baseDir, normalizedRepoName, 'sessions');
        await fs.mkdir(sessionsDir, { recursive: true });
        
        // Move the repository
        await fs.rename(legacyPath, newPath);
        
        // Update the repo path in the session record
        session.repoPath = newPath;
      }
    }
    
    // Save updated sessions
    await this.saveSessions(sessions);
  }
} 

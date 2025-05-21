/**
 * SessionDB Adapter
 * This module provides a backward-compatible adapter that implements the SessionProviderInterface
 * and connects the pure functions with the I/O operations.
 */

import { MinskyError, ResourceNotFoundError } from "../../errors/index.js";
import type { SessionProviderInterface } from "../session.js";
import type { SessionRecord } from "./session-db.js";
import {
  addSessionFn,
  deleteSessionFn,
  getNewSessionRepoPathFn,
  getRepoPathFn,
  getSessionByTaskIdFn,
  getSessionFn,
  getSessionWorkdirFn,
  initializeSessionDbState,
  listSessionsFn,
  updateSessionFn,
  type SessionDbState,
} from "./session-db.js";
import {
  ensureBaseDir,
  getDefaultBaseDir,
  getDefaultDbPath,
  migrateSessionsToSubdirectoryFn,
  readSessionDbFile,
  writeSessionDbFile,
} from "./session-db-io.js";

/**
 * Adapter class that implements SessionProviderInterface using functional style
 * Connects pure functions with I/O operations for backward compatibility
 */
export class SessionDbAdapter implements SessionProviderInterface {
  private readonly dbPath: string;
  private readonly baseDir: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || getDefaultDbPath();
    this.baseDir = dbPath ? getDefaultBaseDir() : getDefaultBaseDir();
  }

  /**
   * Initializes the session database state
   * @returns Initialized session database state
   */
  private async getDbState(): Promise<SessionDbState> {
    const sessions = await readSessionDbFile(this.dbPath);
    return {
      sessions,
      baseDir: this.baseDir,
    };
  }

  /**
   * Lists all sessions in the database
   * @returns Array of session records
   */
  async listSessions(): Promise<SessionRecord[]> {
    const state = await this.getDbState();
    return listSessionsFn(state);
  }

  /**
   * Gets a session by name
   * @param session Session name
   * @returns SessionRecord if found, null otherwise
   */
  async getSession(session: string): Promise<SessionRecord | null> {
    const state = await this.getDbState();
    return getSessionFn(state, session);
  }

  /**
   * Gets a session by task ID
   * @param taskId Task ID
   * @returns SessionRecord if found, null otherwise
   */
  async getSessionByTaskId(taskId: string): Promise<SessionRecord | null> {
    try {
      const state = await this.getDbState();
      return getSessionByTaskIdFn(state, taskId);
    } catch (error) {
      console.error(
        `Error finding session by task ID: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  /**
   * Adds a new session to the database
   * @param record Session record to add
   */
  async addSession(record: SessionRecord): Promise<void> {
    const state = await this.getDbState();
    const newState = addSessionFn(state, record);
    await writeSessionDbFile(this.dbPath, newState.sessions);
  }

  /**
   * Updates an existing session
   * @param session Session name
   * @param updates Partial session record with updates
   */
  async updateSession(
    session: string,
    updates: Partial<Omit<SessionRecord, "session">>
  ): Promise<void> {
    const state = await this.getDbState();
    const newState = updateSessionFn(state, session, updates);
    await writeSessionDbFile(this.dbPath, newState.sessions);
  }

  /**
   * Deletes a session
   * @param session Session name
   * @returns True if session was deleted, false otherwise
   */
  async deleteSession(session: string): Promise<boolean> {
    try {
      const state = await this.getDbState();
      const originalLength = state.sessions.length;
      const newState = deleteSessionFn(state, session);

      if (newState.sessions.length === originalLength) {
        return false; // No session was deleted
      }

      await writeSessionDbFile(this.dbPath, newState.sessions);
      return true;
    } catch (error) {
      console.error(
        `Error deleting session: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  /**
   * Gets the repository path for a session
   * @param record Session record or object containing session info
   * @returns Repository path
   */
  async getRepoPath(record: SessionRecord | any): Promise<string> {
    // Add defensive checks for the input
    if (!record) {
      throw new Error("Session record is required");
    }

    // Special handling for SessionResult type returned by startSessionFromParams
    if (record.sessionRecord) {
      return this.getRepoPath(record.sessionRecord);
    }

    // Special handling for CloneResult
    if (record.cloneResult && record.cloneResult.workdir) {
      return record.cloneResult.workdir;
    }

    const state = await this.getDbState();
    return getRepoPathFn(state, record);
  }

  /**
   * Gets the working directory for a session
   * @param sessionName Session name
   * @returns Working directory path
   */
  async getSessionWorkdir(sessionName: string): Promise<string> {
    const state = await this.getDbState();
    const workdir = getSessionWorkdirFn(state, sessionName);
    if (!workdir) {
      throw new ResourceNotFoundError(
        `Session "${sessionName}" not found.`,
        "session",
        sessionName
      );
    }
    return workdir;
  }

  /**
   * Gets the new repository path with sessions subdirectory for a session
   * @param repoName Repository name
   * @param sessionId Session ID
   * @returns New repository path
   */
  getNewSessionRepoPath(repoName: string, sessionId: string): string {
    const state = initializeSessionDbState({ baseDir: this.baseDir });
    return getNewSessionRepoPathFn(state, repoName, sessionId);
  }

  /**
   * Migrates sessions to use the sessions subdirectory structure
   */
  async migrateSessionsToSubdirectory(): Promise<void> {
    const sessions = await readSessionDbFile(this.dbPath);
    await ensureBaseDir(this.baseDir);

    const result = await migrateSessionsToSubdirectoryFn(this.baseDir, sessions);

    if (result.modified) {
      await writeSessionDbFile(this.dbPath, result.sessions);
    }
  }

  /**
   * For backward compatibility with tests
   * @deprecated Use listSessions instead
   */
  async getSessions(): Promise<SessionRecord[]> {
    return this.listSessions();
  }

  /**
   * For backward compatibility with tests
   * @deprecated Use writeSessionDbFile instead
   */
  async saveSessions(sessions: SessionRecord[]): Promise<void> {
    await writeSessionDbFile(this.dbPath, sessions);
  }
}

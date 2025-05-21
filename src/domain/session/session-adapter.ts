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
import { join } from "path";

/**
 * Adapter class for SessionDB
 * Provides backward compatibility with the class-based implementation
 */

/**
 * Interface for session provider
 */
export interface SessionProviderInterface {
  /**
   * Get all available sessions
   */
  listSessions(): Promise<SessionRecord[]>;

  /**
   * Get a specific session by name
   */
  getSession(session: string): Promise<SessionRecord | null>;

  /**
   * Get a specific session by task ID
   */
  getSessionByTaskId(taskId: string): Promise<SessionRecord | null>;

  /**
   * Add a new session to the database
   */
  addSession(record: SessionRecord): Promise<void>;

  /**
   * Update an existing session
   */
  updateSession(session: string, updates: Partial<Omit<SessionRecord, "session">>): Promise<void>;

  /**
   * Delete a session by name
   */
  deleteSession(session: string): Promise<boolean>;

  /**
   * Get the repository path for a session
   */
  getRepoPath(record: SessionRecord): Promise<string>;

  /**
   * Get the working directory for a session
   */
  getSessionWorkdir(sessionName: string): Promise<string | null>;
}

/**
 * Adapter class for the functional SessionDB implementation
 * Maintains backward compatibility with the original class-based implementation
 */
export class SessionAdapter implements SessionProviderInterface {
  private readonly dbPath: string;
  private readonly baseDir: string;
  private state: SessionDbState;

  constructor(dbPath?: string) {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");

    if (dbPath) {
      this.dbPath = dbPath;
      // For custom dbPath, set baseDir based on a parallel directory structure
      this.baseDir = join(dbPath, "..", "..", "git");
    } else {
      this.dbPath = join(xdgStateHome, "minsky", "session-db.json");
      this.baseDir = join(xdgStateHome, "minsky", "git");
    }

    // Initialize state (will be populated on first read)
    this.state = initializeSessionDbState({ baseDir: this.baseDir });
  }

  /**
   * Read database from disk
   */
  private async readDb(): Promise<SessionRecord[]> {
    this.state = readSessionDbFile({ dbPath: this.dbPath, baseDir: this.baseDir });
    return this.state.sessions;
  }

  /**
   * Write database to disk
   */
  private async writeDb(sessions: SessionRecord[]): Promise<void> {
    // Update state first
    this.state = {
      ...this.state,
      sessions,
    };
    // Then write to disk
    writeSessionDbFile(this.state, { dbPath: this.dbPath });
  }

  /**
   * Get all sessions
   */
  async listSessions(): Promise<SessionRecord[]> {
    return this.readDb();
  }

  /**
   * Get a session by name
   */
  async getSession(session: string): Promise<SessionRecord | null> {
    await this.readDb();
    return getSessionFn(this.state, session);
  }

  /**
   * Get a session by task ID
   */
  async getSessionByTaskId(taskId: string): Promise<SessionRecord | null> {
    await this.readDb();
    return getSessionByTaskIdFn(this.state, taskId);
  }

  /**
   * Add a new session
   */
  async addSession(record: SessionRecord): Promise<void> {
    const sessions = await this.readDb();
    const newState = addSessionFn(this.state, record);
    await this.writeDb(newState.sessions);
  }

  /**
   * Update an existing session
   */
  async updateSession(
    session: string,
    updates: Partial<Omit<SessionRecord, "session">>
  ): Promise<void> {
    await this.readDb();
    const newState = updateSessionFn(this.state, session, updates);
    await this.writeDb(newState.sessions);
  }

  /**
   * Delete a session
   */
  async deleteSession(session: string): Promise<boolean> {
    try {
      await this.readDb();
      const newState = deleteSessionFn(this.state, session);
      
      // If no change occurred (session not found)
      if (newState.sessions.length === this.state.sessions.length) {
        return false;
      }
      
      await this.writeDb(newState.sessions);
      return true;
    } catch (error) {
      console.error(
        `Error deleting session: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  /**
   * Get the repository path for a session
   */
  async getRepoPath(record: SessionRecord): Promise<string> {
    await this.readDb();
    return getRepoPathFn(this.state, record);
  }

  /**
   * Get the working directory for a session
   */
  async getSessionWorkdir(sessionName: string): Promise<string | null> {
    await this.readDb();
    return getSessionWorkdirFn(this.state, sessionName);
  }
}

/**
 * Factory function to create a session provider instance
 * This allows for easier testing and dependency injection
 */
export function createSessionProvider(dbPath?: string): SessionProviderInterface {
  return new SessionAdapter(dbPath);
}

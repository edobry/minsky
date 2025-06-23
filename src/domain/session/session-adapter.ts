/**
 * SessionDB Adapter
 * This module provides a backward-compatible adapter that implements the SessionProviderInterface
 * and connects the pure functions with the I/O operations.
 */

import { join } from "path";
import type {SessionDbState } from "./session-db"; // Type-only imports
import {
  initializeSessionDbState,
  listSessionsFn,
  getSessionFn,
  getSessionByTaskIdFn,
  addSessionFn,
  updateSessionFn,
  deleteSessionFn,
  getRepoPathFn,
  getSessionWorkdirFn,
} from "./session-db"; // Value imports
import { readSessionDbFile, writeSessionDbFile } from "./session-db-io";

/**
 * Interface for session provider
 * This local definition avoids conflict with any potential global/external one.
 */
export interface LocalSessionProviderInterface {
  /**
   * Get all available sessions
   */
  listSessions(): Promise<SessionRecord[]>;

  /**
   * Get a specific session by name
   */
  getSession(__session: string): Promise<SessionRecord | null>;

  /**
   * Get a specific session by task ID
   */
  getSessionByTaskId(__taskId: string): Promise<SessionRecord | null>;

  /**
   * Add a new session to the database
   */
  addSession(__record: SessionRecord): Promise<void>;

  /**
   * Update an existing session
   */
  updateSession(__session: string, _updates: Partial<Omit<"session">>): Promise<void>;

  /**
   * Delete a session by name
   */
  deleteSession(__session: string): Promise<boolean>;

  /**
   * Get the repository path for a session
   */
  getRepoPath(__record: SessionRecord): Promise<string>;

  /**
   * Get the working directory for a session
   */
  getSessionWorkdir(__sessionName: string): Promise<string | null>;
}

/**
 * Adapter class for the functional SessionDB implementation
 * Maintains backward compatibility with the original class-based implementation
 */
export class SessionAdapter implements LocalSessionProviderInterface {
  private readonly dbPath: string;
  private readonly baseDir: string;
  private state: SessionDbState;

  constructor(dbPath?: string) {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");

    if (dbPath) {
      this.dbPath = dbPath;
      // For custom dbPath, set baseDir based on a parallel directory structure
      this.baseDir = join(_dbPath, "..", "..", "git");
    } else {
      this.dbPath = join(_xdgStateHome, "minsky", "session-db.json");
      this.baseDir = join(_xdgStateHome, "minsky", "git");
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
  private async writeDb(_sessions: SessionRecord[]): Promise<void> {
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
  async getSession(__session: string): Promise<SessionRecord | null> {
    await this.readDb();
    return getSessionFn(this.state, _session);
  }

  /**
   * Get a session by task ID
   */
  async getSessionByTaskId(__taskId: string): Promise<SessionRecord | null> {
    await this.readDb();
    return getSessionByTaskIdFn(this.state, _taskId);
  }

  /**
   * Add a new session
   */
  async addSession(__record: SessionRecord): Promise<void> {
    await this.readDb();
    const newState = addSessionFn(this.state, _record);
    await this.writeDb(newState.sessions);
  }

  /**
   * Update an existing session
   */
  async updateSession(__session: string,
    _updates: Partial<Omit<"session">>
  ): Promise<void> {
    await this.readDb();
    const newState = updateSessionFn(this.state, _session, _updates);
    await this.writeDb(newState.sessions);
  }

  /**
   * Delete a session
   */
  async deleteSession(__session: string): Promise<boolean> {
    await this.readDb();
    const originalLength = this.state.sessions.length;
    const newState = deleteSessionFn(this.state, _session);

    // If no change occurred (session not found)
    if (newState.sessions.length === originalLength) {
      return false;
    }

    await this.writeDb(newState.sessions);
    return true;
  }

  /**
   * Get the repository path for a session
   */
  async getRepoPath(__record: SessionRecord): Promise<string> {
    await this.readDb();
    return getRepoPathFn(this.state, _record);
  }

  /**
   * Get the working directory for a session
   */
  async getSessionWorkdir(__sessionName: string): Promise<string | null> {
    await this.readDb();
    return getSessionWorkdirFn(this.state, _sessionName);
  }
}

/**
 * Factory function to create a session provider instance
 * This allows for easier testing and dependency injection
 */
export function createSessionProvider(dbPath?: string): LocalSessionProviderInterface {
  return new SessionAdapter(dbPath);
}

/**
 * SessionDB Adapter
 * This module provides a backward-compatible adapter that implements the SessionProviderInterface
 * and connects the pure functions with the I/O operations.
 */

import { join } from "path";
import type { SessionDbState, SessionRecord } from "./session-db"; // Type-only imports
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
import { getMinskyStateDir, getDefaultJsonDbPath } from "../../utils/paths";

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
  getSession(session: string): Promise<SessionRecord | null>;

  /**
   * Get a specific session by task ID
   */
  getSessionByTaskId(_taskId: string): Promise<SessionRecord | null>;

  /**
   * Add a new session to the database
   */
  addSession(_record: SessionRecord): Promise<void>;

  /**
   * Update an existing session
   */
  updateSession(session: string, _updates: Partial<Omit<SessionRecord, "session">>): Promise<void>;

  /**
   * Delete a session by name
   */
  deleteSession(session: string): Promise<boolean>;

  /**
   * Get the repository path for a session
   */
  getRepoPath(_record: SessionRecord): Promise<string>;

  /**
   * Get the working directory for a session
   */
  getSessionWorkdir(_sessionName: string): Promise<string | undefined>;
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
    const xdgStateHome =
      (process.env as any).XDG_STATE_HOME || join((process.env as any).HOME || "", ".local/state");

    if (dbPath) {
      this.dbPath = dbPath;
      // For custom dbPath, set baseDir based on a parallel directory structure
      this.baseDir = join(dbPath, "..", "..");
    } else {
      this.dbPath = join(xdgStateHome, "minsky", "session-db.json");
      this.baseDir = join(xdgStateHome, "minsky");
    }

    // Initialize state (will be populated on first read)
    this.state = initializeSessionDbState({ baseDir: this.baseDir });
  }

  /**
   * Read database from disk
   */
  private async readDb(): Promise<SessionRecord[]> {
    this.state = readSessionDbFile({ dbPath: this.dbPath, baseDir: this.baseDir });
    return (this.state as any).sessions;
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
  async getSessionByTaskId(_taskId: string): Promise<SessionRecord | null> {
    await this.readDb();
    return getSessionByTaskIdFn(this.state, _taskId);
  }

  /**
   * Add a new session
   */
  async addSession(_record: SessionRecord): Promise<void> {
    await this.readDb();
    const newState = addSessionFn(this.state, _record);
    await this.writeDb((newState as any).sessions);
  }

  /**
   * Update an existing session
   */
  async updateSession(
    session: string,
    _updates: Partial<Omit<SessionRecord, "session">>
  ): Promise<void> {
    await this.readDb();
    const newState = updateSessionFn(this.state, session, _updates);
    await this.writeDb((newState as any).sessions);
  }

  /**
   * Delete a session
   */
  async deleteSession(session: string): Promise<boolean> {
    await this.readDb();
    const originalLength = (this.state.sessions as any).length;
    const newState = deleteSessionFn(this.state, session);

    // If no change occurred (session not found)
    if ((newState.sessions as any).length === originalLength) {
      return false;
    }

    await this.writeDb((newState as any).sessions);
    return true;
  }

  /**
   * Get the repository path for a session
   */
  async getRepoPath(_record: SessionRecord): Promise<string> {
    await this.readDb();
    return getRepoPathFn(this.state, _record);
  }

  /**
   * Get the working directory for a session
   */
  async getSessionWorkdir(_sessionName: string): Promise<string | undefined> {
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

/**
 * JsonFileStorage Backend
 * 
 * This module implements the DatabaseStorage interface for JSON file storage,
 * wrapping the existing session-db-io.ts functionality.
 */

import { join, dirname } from "path";
import { existsSync, mkdirSync } from "fs";
import type { DatabaseStorage, DatabaseReadResult, DatabaseWriteResult, DatabaseQueryOptions } from "../database-storage";
import type { SessionRecord, SessionDbState } from "../../session/session-db";
import { readSessionDbFile, writeSessionDbFile, type SessionDbFileOptions } from "../../session/session-db-io";
import { initializeSessionDbState } from "../../session/session-db";
import { log } from "../../../utils/logger";

/**
 * JSON File Storage implementation for session records
 */
export class JsonFileStorage implements DatabaseStorage<SessionRecord, SessionDbState> {
  private readonly dbPath: string;
  private readonly baseDir: string;

  constructor(dbPath?: string, baseDir?: string) {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
    
    if (dbPath) {
      this.dbPath = dbPath;
      this.baseDir = baseDir || join(dbPath, "..", "..", "git");
    } else {
      this.dbPath = join(xdgStateHome, "minsky", "session-db.json");
      this.baseDir = baseDir || join(xdgStateHome, "minsky", "git");
    }
  }

  private getFileOptions(): SessionDbFileOptions {
    return {
      dbPath: this.dbPath,
      baseDir: this.baseDir,
    };
  }

  async readState(): Promise<DatabaseReadResult<SessionDbState>> {
    try {
      const state = readSessionDbFile(this.getFileOptions());
      return {
        success: true,
        data: state,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error(`Error reading session database: ${err.message}`);
      return {
        success: false,
        error: err,
      };
    }
  }

  async writeState(state: SessionDbState): Promise<DatabaseWriteResult> {
    try {
      const success = writeSessionDbFile(state, this.getFileOptions());
      return {
        success,
        bytesWritten: success ? JSON.stringify(state.sessions).length : 0,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error(`Error writing session database: ${err.message}`);
      return {
        success: false,
        error: err,
      };
    }
  }

  async getEntity(id: string, _options?: DatabaseQueryOptions): Promise<SessionRecord | null> {
    const result = await this.readState();
    if (!result.success || !result.data) {
      return null;
    }

    return result.data.sessions.find(session => session.session === id) || null;
  }

  async getEntities(options?: DatabaseQueryOptions): Promise<SessionRecord[]> {
    const result = await this.readState();
    if (!result.success || !result.data) {
      return [];
    }

    let sessions = result.data.sessions;

    // Apply filters if provided
    if (options) {
      if (options.taskId) {
        const normalizedTaskId = options.taskId.replace(/^#/, "");
        sessions = sessions.filter(s => s.taskId.replace(/^#/, "") === normalizedTaskId);
      }
      if (options.repoName) {
        sessions = sessions.filter(s => s.repoName === options.repoName);
      }
      if (options.branch) {
        sessions = sessions.filter(s => s.branch === options.branch);
      }
    }

    return sessions;
  }

  async createEntity(entity: SessionRecord): Promise<SessionRecord> {
    const result = await this.readState();
    if (!result.success || !result.data) {
      throw new Error("Failed to read current state");
    }

    const newState: SessionDbState = {
      ...result.data,
      sessions: [...result.data.sessions, entity],
    };

    const writeResult = await this.writeState(newState);
    if (!writeResult.success) {
      throw new Error(`Failed to create entity: ${writeResult.error?.message}`);
    }

    return entity;
  }

  async updateEntity(id: string, updates: Partial<SessionRecord>): Promise<SessionRecord | null> {
    const result = await this.readState();
    if (!result.success || !result.data) {
      return null;
    }

    const sessionIndex = result.data.sessions.findIndex(s => s.session === id);
    if (sessionIndex === -1) {
      return null;
    }

    // Create safe updates by explicitly building the update object without session
    const safeUpdates: Partial<Omit<SessionRecord, "session">> = {};
    Object.entries(updates).forEach(([key, value]) => {
      if (key !== "session") {
        (safeUpdates as any)[key] = value;
      }
    });
    
    const updatedSession: SessionRecord = { ...result.data.sessions[sessionIndex], ...safeUpdates };
    
    const newSessions = [...result.data.sessions];
    newSessions[sessionIndex] = updatedSession;

    const newState: SessionDbState = {
      ...result.data,
      sessions: newSessions,
    };

    const writeResult = await this.writeState(newState);
    if (!writeResult.success) {
      throw new Error(`Failed to update entity: ${writeResult.error?.message}`);
    }

    return updatedSession;
  }

  async deleteEntity(id: string): Promise<boolean> {
    const result = await this.readState();
    if (!result.success || !result.data) {
      return false;
    }

    const sessionIndex = result.data.sessions.findIndex(s => s.session === id);
    if (sessionIndex === -1) {
      return false;
    }

    const newSessions = [...result.data.sessions];
    newSessions.splice(sessionIndex, 1);

    const newState: SessionDbState = {
      ...result.data,
      sessions: newSessions,
    };

    const writeResult = await this.writeState(newState);
    return writeResult.success;
  }

  async entityExists(id: string): Promise<boolean> {
    const entity = await this.getEntity(id);
    return entity !== null;
  }

  getStorageLocation(): string {
    return this.dbPath;
  }

  async initialize(): Promise<boolean> {
    try {
      // Ensure directory exists
      const dbDir = dirname(this.dbPath);
      if (!existsSync(dbDir)) {
        mkdirSync(dbDir, { recursive: true });
      }

      // If file doesn't exist, create initial state
      if (!existsSync(this.dbPath)) {
        const initialState = initializeSessionDbState({ baseDir: this.baseDir });
        const writeResult = await this.writeState(initialState);
        return writeResult.success;
      }

      return true;
    } catch (error) {
      log.error(`Error initializing JSON file storage: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
} 

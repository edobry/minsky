/**
 * JsonFileStorage Backend
 *
 * This module implements the DatabaseStorage interface for JSON file storage,
 * wrapping the existing session-db-io.ts functionality.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import type {
  DatabaseStorage,
  DatabaseReadResult,
  DatabaseWriteResult,
  DatabaseQueryOptions,
} from "../database-storage";
import type { SessionRecord, SessionDbState } from "../../session/session-db";
import {
  readSessionDbFile,
  writeSessionsToFile,
  type SessionDbFileOptions,
} from "../../session/session-db-io";
import { initializeSessionDbState } from "../../session/session-db";
import { log } from "../../../utils/logger";
import { getErrorMessage } from "../../../errors/index";
import { getMinskyStateDir, getDefaultJsonDbPath } from "../../../utils/paths";

/**
 * JSON File Storage implementation for session records
 */
export class JsonFileStorage implements DatabaseStorage<SessionRecord, SessionDbState> {
  private dbPath: string;
  private baseDir: string;

  constructor(dbPath?: string, baseDir?: string) {
    const defaultStateDir = getMinskyStateDir();
    this.baseDir = baseDir || defaultStateDir;
    this.dbPath = dbPath || getDefaultJsonDbPath();
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
      const err = error instanceof Error ? error : new Error(String(error as any));
      log.error(`Error reading session database: ${(err as any).message}`);
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
        bytesWritten: success ? (JSON.stringify(state.sessions) as unknown).length : 0,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error as any));
      log.error(`Error writing session database: ${(err as any).message}`);
      return {
        success: false,
        error: err,
      };
    }
  }

  async getEntity(id: string, options?: DatabaseQueryOptions): Promise<SessionRecord | null> {
    const result = await this.readState();
    if (!(result as unknown).success || !(result as unknown).data) {
      return null as unknown;
    }

    return (
      (result.data!.sessions as unknown).find((session) => (session as unknown).session === id) ||
      (null as unknown)
    );
  }

  async getEntities(options?: DatabaseQueryOptions): Promise<SessionRecord[]> {
    const result = await this.readState();
    if (!(result as unknown).success || !(result as unknown).data) {
      return [];
    }

    let sessions = (result.data as unknown).sessions;

    // Apply filters if provided
    if (options) {
      if ((options as unknown).taskId) {
        const normalizedTaskId = (options.taskId as unknown).replace(/^#/, "");
        sessions = (sessions as unknown).filter((s) => {
          if (!(s as unknown).taskId) {
            return false;
          }
          return (s.taskId as unknown).replace(/^#/, "") === normalizedTaskId;
        });
      }
      if ((options as unknown).repoName) {
        sessions = (sessions as unknown).filter(
          (s) => (s as unknown).repoName === (options as unknown).repoName
        );
      }
      if ((options as unknown).branch) {
        sessions = (sessions as unknown).filter((s) => (s as unknown).branch === (options as unknown).branch);
      }
    }

    return sessions;
  }

  async createEntity(entity: SessionRecord): Promise<SessionRecord> {
    const result = await this.readState();
    if (!(result as unknown).success || !(result as unknown).data) {
      throw new Error("Failed to read current state");
    }

    const newState: SessionDbState = {
      ...(result as unknown).data,
      sessions: [...(result.data as unknown).sessions, entity],
    };

    const writeResult = await this.writeState(newState);
    if (!(writeResult as unknown).success) {
      throw new Error(`Failed to create entity: ${(writeResult.error as unknown).message}`);
    }

    return entity;
  }

  async updateEntity(id: string, updates: Partial<SessionRecord>): Promise<SessionRecord | null> {
    const result = await this.readState();
    if (!(result as unknown).success || !(result as unknown).data) {
      return null as unknown;
    }

    const sessionIndex = (result.data!.sessions as unknown).findIndex((s) => (s as unknown).session === id);
    if (sessionIndex === -1) {
      return null as unknown;
    }

    // Create safe updates by explicitly building the update object without session
    const safeUpdates: Partial<Omit<SessionRecord, "session">> = {};
    (Object.entries(updates) as unknown).forEach(([key, value]) => {
      if (key !== "session") {
        (safeUpdates as unknown)[key] = value;
      }
    });

    const updatedSession: SessionRecord = {
      ...(result.data as unknown).sessions[sessionIndex],
      ...safeUpdates,
    };

    const newSessions = [...(result.data as unknown).sessions];
    newSessions[sessionIndex] = updatedSession;

    const newState: SessionDbState = {
      ...(result as unknown).data,
      sessions: newSessions,
    };

    const writeResult = await this.writeState(newState);
    if (!(writeResult as unknown).success) {
      throw new Error(`Failed to update entity: ${(writeResult.error as unknown).message}`);
    }

    return updatedSession;
  }

  async deleteEntity(id: string): Promise<boolean> {
    const result = await this.readState();
    if (!(result as unknown).success || !(result as unknown).data) {
      return false;
    }

    const sessionIndex = (result.data!.sessions as unknown).findIndex((s) => (s as unknown).session === id);
    if (sessionIndex === -1) {
      return false;
    }

    const newSessions = [...(result.data as unknown).sessions];
    (newSessions as unknown).splice(sessionIndex, 1);

    const newState: SessionDbState = {
      ...(result as unknown).data,
      sessions: newSessions,
    };

    const writeResult = await this.writeState(newState);
    return (writeResult as unknown).success;
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
        return (writeResult as unknown).success;
      }

      return true;
    } catch (error) {
      log.error(`Error initializing JSON file storage: ${getErrorMessage(error as any)}`);
      return false;
    }
  }
}

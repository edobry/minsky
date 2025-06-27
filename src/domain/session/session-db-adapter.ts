/**
 * SessionDbAdapter
 *
 * This adapter implements the SessionProviderInterface using the new
 * configuration-based storage backend system. It provides seamless
 * integration with JSON, SQLite, and PostgreSQL storage backends.
 */

import type { SessionProviderInterface, SessionRecord } from "../session";
import { createStorageBackend, type StorageConfig } from "../storage/storage-backend-factory";
import type { DatabaseStorage } from "../storage/database-storage";
import type { SessionDbState } from "./session-db";
import { initializeSessionDbState, getRepoPathFn } from "./session-db";
import { log } from "../../utils/logger";
import { configurationService } from "../configuration";
import { homedir } from "os";
import { join } from "path";

export class SessionDbAdapter implements SessionProviderInterface {
  private storage: DatabaseStorage<SessionRecord, SessionDbState> | null = null;
  private readonly workingDir: string;

  constructor(workingDir?: string) {
    this.workingDir = workingDir || process.cwd();
  }

  private async getStorage(): Promise<DatabaseStorage<SessionRecord, SessionDbState>> {
    if (!this.storage) {
      // Load configuration to determine storage backend
      const configResult = await configurationService.loadConfiguration(this.workingDir);
      const sessionDbConfig = configResult.resolved.sessiondb;

      // Convert SessionDbConfig to StorageConfig
      const storageConfig: Partial<StorageConfig> = {
        backend: sessionDbConfig.backend as "json" | "sqlite" | "postgres",
      };

      if (sessionDbConfig.backend === "sqlite" && sessionDbConfig.dbPath) {
        storageConfig.sqlite = { dbPath: this.expandPath(sessionDbConfig.dbPath) };
      } else if (sessionDbConfig.backend === "postgres" && sessionDbConfig.connectionString) {
        storageConfig.postgres = { connectionUrl: sessionDbConfig.connectionString };
      } else if (sessionDbConfig.backend === "json" && sessionDbConfig.dbPath) {
        storageConfig.json = { filePath: this.expandPath(sessionDbConfig.dbPath) };
      }

      this.storage = createStorageBackend(storageConfig);
      await this.storage.initialize();
    }
    return this.storage;
  }

  /**
   * Expand tilde and environment variables in file paths
   */
  private expandPath(filePath: string): string {
    if (filePath.startsWith("~/")) {
      return join(homedir(), filePath.slice(2));
    }
    if (filePath.startsWith("$HOME/")) {
      return join(homedir(), filePath.slice(6));
    }
    return filePath;
  }

  async listSessions(): Promise<SessionRecord[]> {
    try {
      const storage = await this.getStorage();
      return await storage.getEntities();
    } catch (error) {
      log.error(
        `Error listing sessions: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }

  async getSession(session: string): Promise<SessionRecord | null> {
    try {
      const storage = await this.getStorage();
      return await storage.getEntity(session);
    } catch (error) {
      log.error(`Error getting session: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async getSessionByTaskId(taskId: string): Promise<SessionRecord | null> {
    try {
      const storage = await this.getStorage();
      // Normalize taskId for consistent searching
      const normalizedTaskId = taskId.replace(/^#/, "");
      const sessions = await storage.getEntities({ taskId: normalizedTaskId });
      const session = sessions.length > 0 ? sessions[0] : null;
      return session || null;
    } catch (error) {
      log.error(
        `Error getting session by task ID: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  async addSession(record: SessionRecord): Promise<void> {
    try {
      const storage = await this.getStorage();
      await storage.createEntity(record);
    } catch (error) {
      log.error(`Error adding session: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async updateSession(
    session: string,
    updates: Partial<Omit<SessionRecord, "session">>
  ): Promise<void> {
    try {
      const storage = await this.getStorage();
      const result = await storage.updateEntity(session, updates);
      if (!result) {
        throw new Error(`Session '${session}' not found`);
      }
    } catch (error) {
      log.error(
        `Error updating session: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  async deleteSession(session: string): Promise<boolean> {
    try {
      const storage = await this.getStorage();
      return await storage.deleteEntity(session);
    } catch (error) {
      log.error(
        `Error deleting session: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  async getRepoPath(record: SessionRecord | any): Promise<string> {
    if (!record) {
      throw new Error("Session record is required");
    }

    // Handle different record types (SessionRecord, SessionResult, etc.)
    if (record.sessionRecord) {
      return this.getRepoPath(record.sessionRecord);
    }

    if (record.cloneResult && record.cloneResult.workdir) {
      return record.cloneResult.workdir;
    }

    if (record.workdir) {
      return record.workdir;
    }

    if (record.repoPath) {
      return record.repoPath;
    }

    // Use the functional implementation to compute the path
    const state = await this.getState();
    return getRepoPathFn(state, record);
  }

  async getSessionWorkdir(sessionName: string): Promise<string> {
    const session = await this.getSession(sessionName);
    if (!session) {
      throw new Error(`Session '${sessionName}' not found`);
    }
    return this.getRepoPath(session);
  }

  /**
   * Get the current storage state for functional operations
   */
  private async getState(): Promise<SessionDbState> {
    try {
      const storage = await this.getStorage();
      const result = await storage.readState();

      if (result.success && result.data) {
        return result.data;
      }

      // Return initialized state if read fails
      return initializeSessionDbState();
    } catch (error) {
      log.warn(
        `Error reading storage state, using defaults: ${error instanceof Error ? error.message : String(error)}`
      );
      return initializeSessionDbState();
    }
  }

  /**
   * Get storage backend information for debugging
   */
  async getStorageInfo(): Promise<{ backend: string; location: string }> {
    const storage = await this.getStorage();
    return {
      backend: storage.constructor.name,
      location: storage.getStorageLocation(),
    };
  }
}

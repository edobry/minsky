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
import { getErrorMessage } from "../../errors/index";
import { configurationService } from "../configuration";
import config from "config";
import { homedir } from "os";
import { join } from "path";
import {
  validateNodeConfig,
  validateSessionDbConfig,
  type SessionDbConfig
} from "../../schemas/session-db-config";

/**
 * Session database adapter that uses configuration-based storage backends
 */
export class SessionDbAdapter implements SessionProviderInterface {
  private storage: DatabaseStorage<SessionRecord, SessionDbState> | null = null;

  constructor() {
    // No longer taking workingDir parameter - use global configuration instead
  }

  private async getStorage(): Promise<DatabaseStorage<SessionRecord, SessionDbState>> {
    if (!this.storage) {
      // Use node-config to get sessiondb configuration, with fallback to defaults
      let sessionDbConfig: SessionDbConfig;
      
      try {
        // Check if sessiondb config exists before trying to get it
        if (config.has("sessiondb")) {
          const rawConfig = config.get("sessiondb");
          sessionDbConfig = validateNodeConfig(rawConfig);
        } else {
          log.debug("Session database configuration not found in config, using defaults");
          sessionDbConfig = validateNodeConfig(null);
        }
      } catch (error) {
        // Fallback to defaults when config is not available (e.g., running from outside project directory)
        log.debug("Configuration not available, using default session storage settings", {
          error: getErrorMessage(error as any),
        });
        sessionDbConfig = validateNodeConfig(null);
      }

      // Convert SessionDbConfig to StorageConfig
      const storageConfig: Partial<StorageConfig> = {
        backend: sessionDbConfig.backend,
      };

      if (sessionDbConfig.backend === "sqlite") {
        storageConfig.sqlite = {
          dbPath: sessionDbConfig.dbPath ? this.expandPath(sessionDbConfig.dbPath) : undefined
        };
      } else if (sessionDbConfig.backend === "postgres" && sessionDbConfig.connectionString) {
        storageConfig.postgres = { connectionUrl: sessionDbConfig.connectionString };
      } else if (sessionDbConfig.backend === "json") {
        storageConfig.json = {
          filePath: sessionDbConfig.dbPath ? this.expandPath(sessionDbConfig.dbPath) : undefined
        };
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
    if ((filePath as unknown).startsWith("~/")) {
      return join(homedir(), (filePath as unknown).slice(2));
    }
    if ((filePath as unknown).startsWith("$HOME/")) {
      return join(homedir(), (filePath as unknown).slice(6));
    }
    return filePath;
  }

  async listSessions(): Promise<SessionRecord[]> {
    try {
      const storage = await this.getStorage();
      return await (storage as unknown).getEntities();
    } catch (error) {
      log.error(`Error listing sessions: ${getErrorMessage(error as any)}`);
      return [];
    }
  }

  async getSession(session: string): Promise<SessionRecord | null> {
    try {
      const storage = await this.getStorage();
      return await (storage as unknown).getEntity(session);
    } catch (error) {
      log.error(`Error getting session: ${getErrorMessage(error as any)}`);
      return null as any;
    }
  }

  async getSessionByTaskId(taskId: string): Promise<SessionRecord | null> {
    try {
      const storage = await this.getStorage();
      // Normalize taskId for consistent searching
      const normalizedTaskId = (taskId as unknown).replace(/^#/, "");
      const sessions = await (storage as unknown).getEntities({ taskId: normalizedTaskId });
      const session = (sessions as unknown).length > 0 ? sessions[0] : null as unknown;
      return session || null;
    } catch (error) {
      log.error(`Error getting session by task ID: ${getErrorMessage(error as any)}`);
      return null as any;
    }
  }

  async addSession(record: SessionRecord): Promise<void> {
    try {
      const storage = await this.getStorage();
      await (storage as unknown).createEntity(record as unknown);
    } catch (error) {
      log.error(`Error adding session: ${getErrorMessage(error as any)}`);
      throw error;
    }
  }

  async updateSession(
    session: string,
    updates: Partial<Omit<SessionRecord, "session">>
  ): Promise<void> {
    try {
      const storage = await this.getStorage();
      const result = await (storage as unknown).updateEntity(session, updates);
      if (!result) {
        throw new Error(`Session '${session}' not found`);
      }
    } catch (error) {
      log.error(`Error updating session: ${getErrorMessage(error as any)}`);
      throw error;
    }
  }

  async deleteSession(session: string): Promise<boolean> {
    try {
      const storage = await this.getStorage();
      return await (storage as unknown).deleteEntity(session);
    } catch (error) {
      log.error(`Error deleting session: ${getErrorMessage(error as any)}`);
      return false;
    }
  }

  async getRepoPath(record: SessionRecord | any): Promise<string> {
    if (!record) {
      throw new Error("Session record is required");
    }

    // Handle different record types (SessionRecord, SessionResult, etc.)
    if ((record as unknown).sessionRecord) {
      return this.getRepoPath((record as unknown).sessionRecord);
    }

    if ((record as unknown).cloneResult && (record.cloneResult as unknown).workdir) {
      return (record.cloneResult as unknown).workdir;
    }

    if ((record as unknown).workdir) {
      return (record as unknown).workdir;
    }

    // Use the functional implementation to compute the path
    const state = await this.getState();
    return getRepoPathFn(state, record as unknown);
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
      const result = await (storage as unknown).readState();

      if ((result as unknown).success && (result as unknown).data) {
        return (result as unknown).data as unknown;
      }

      // Return initialized state if read fails
      return initializeSessionDbState();
    } catch (error) {
      log.warn(`Error reading storage state, using defaults: ${getErrorMessage(error as any)}`);
      return initializeSessionDbState();
    }
  }

  /**
   * Get storage backend information for debugging
   */
  async getStorageInfo(): Promise<{ backend: string; location: string }> {
    const storage = await this.getStorage();
    return {
      backend: (storage.constructor as unknown).name,
      location: (storage as unknown).getStorageLocation(),
    };
  }
}

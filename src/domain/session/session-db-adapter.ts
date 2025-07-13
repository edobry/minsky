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

export class SessionDbAdapter implements SessionProviderInterface {
  private storage: DatabaseStorage<SessionRecord, SessionDbState> | null = null;

  constructor() {
    // No longer taking workingDir parameter - use global configuration instead
  }

  private async getStorage(): Promise<DatabaseStorage<SessionRecord, SessionDbState>> {
    if (!this.storage) {
      // Use node-config to get sessiondb configuration, with fallback to defaults
      let sessionDbConfig: any;
      
      try {
        // Check if sessiondb config exists before trying to get it
        if ((config as any).has("sessiondb")) {
          sessionDbConfig = (config as any).get("sessiondb") as any;
        } else {
          log.debug("Session database configuration not found in config, using defaults");
          sessionDbConfig = null;
        }
      } catch (error) {
        // Fallback to defaults when config is not available (e.g., running from outside project directory)
        log.debug("Configuration not available, using default session storage settings", {
          error: getErrorMessage(error as any),
        });
        sessionDbConfig = null;
      }

      // Additional check: if sessionDbConfig is null/undefined, use defaults
      if (!sessionDbConfig || typeof sessionDbConfig !== "object") {
        log.debug("Session database configuration is missing or invalid, using defaults");
        sessionDbConfig = {
          backend: "json",
          baseDir: null as any,
          dbPath: null as any,
          connectionString: null as any,
        };
      }

      // Convert SessionDbConfig to StorageConfig
      const storageConfig: Partial<StorageConfig> = {
        backend: (sessionDbConfig as any).backend as "json" | "sqlite" | "postgres",
      };

      if ((sessionDbConfig as any).backend === "sqlite") {
        (storageConfig as any).sqlite = {
          dbPath: (sessionDbConfig as any).dbPath ? this.expandPath((sessionDbConfig as any).dbPath) : undefined
        };
      } else if ((sessionDbConfig as any).backend === "postgres" && (sessionDbConfig as any).connectionString) {
        (storageConfig as any).postgres = { connectionUrl: (sessionDbConfig as any).connectionString };
      } else if ((sessionDbConfig as any).backend === "json") {
        (storageConfig as any).json = {
          filePath: (sessionDbConfig as any).dbPath ? this.expandPath((sessionDbConfig as any).dbPath) : undefined
        };
      }

      this.storage = createStorageBackend(storageConfig);
      await (this.storage as any).initialize();
    }
    return this.storage;
  }

  /**
   * Expand tilde and environment variables in file paths
   */
  private expandPath(filePath: string): string {
    if ((filePath as any).startsWith("~/")) {
      return join(homedir(), (filePath as any).slice(2));
    }
    if ((filePath as any).startsWith("$HOME/")) {
      return join(homedir(), (filePath as any).slice(6));
    }
    return filePath;
  }

  async listSessions(): Promise<SessionRecord[]> {
    try {
      const storage = await this.getStorage();
      return await (storage as any).getEntities();
    } catch (error) {
      log.error(`Error listing sessions: ${getErrorMessage(error as any)}`);
      return [];
    }
  }

  async getSession(session: string): Promise<SessionRecord | null> {
    try {
      const storage = await this.getStorage();
      return await (storage as any).getEntity(session);
    } catch (error) {
      log.error(`Error getting session: ${getErrorMessage(error as any)}`);
      return null as any;
    }
  }

  async getSessionByTaskId(taskId: string): Promise<SessionRecord | null> {
    try {
      const storage = await this.getStorage();
      // Normalize taskId for consistent searching
      const normalizedTaskId = (taskId as any).replace(/^#/, "");
      const sessions = await (storage as any).getEntities({ taskId: normalizedTaskId });
      const session = (sessions as any).length > 0 ? sessions[0] : null as any;
      return session || null;
    } catch (error) {
      log.error(`Error getting session by task ID: ${getErrorMessage(error as any)}`);
      return null as any;
    }
  }

  async addSession(record: SessionRecord): Promise<void> {
    try {
      const storage = await this.getStorage();
      await (storage as any).createEntity(record as any);
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
      const result = await (storage as any).updateEntity(session, updates);
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
      return await (storage as any).deleteEntity(session);
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
    if ((record as any).sessionRecord) {
      return this.getRepoPath((record as any).sessionRecord);
    }

    if ((record as any).cloneResult && (record.cloneResult as any).workdir) {
      return (record.cloneResult as any).workdir;
    }

    if ((record as any).workdir) {
      return (record as any).workdir;
    }

    // Use the functional implementation to compute the path
    const state = await this.getState();
    return getRepoPathFn(state, record as any);
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
      const result = await (storage as any).readState();

      if ((result as any).success && (result as any).data) {
        return (result as any).data as any;
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
      backend: (storage.constructor as any).name,
      location: (storage as any).getStorageLocation(),
    };
  }
}

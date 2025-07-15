/**
 * SessionDbAdapter
 *
 * This adapter implements the SessionProviderInterface using the
 * configuration-based storage backend system with integrity checking.
 * It provides seamless integration with JSON, SQLite, and PostgreSQL storage backends.
 */

import type { SessionProviderInterface, SessionRecord } from "../session";

// Re-export the interface for use in extracted modules
export type { SessionProviderInterface };
import { createStorageBackendWithIntegrity, type StorageConfig, type StorageResult } from "../storage/storage-backend-factory";
import type { DatabaseStorage } from "../storage/database-storage";
import type { SessionDbState } from "./session-db";
import { initializeSessionDbState, getRepoPathFn } from "./session-db";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";

import config from "config";
import { homedir } from "os";
import { join } from "path";

export class SessionDbAdapter implements SessionProviderInterface {
  private storage: DatabaseStorage<SessionRecord, SessionDbState> | null = null;
  private storageWarnings: string[] = [];

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
        sessionDbConfig = {};
      }

      // Build storage configuration
      const storageConfig: Partial<StorageConfig> = {
        backend: sessionDbConfig.backend || "json",
        enableIntegrityCheck: sessionDbConfig.enableIntegrityCheck ?? true,
        autoMigrate: sessionDbConfig.autoMigrate ?? false,
        promptOnIntegrityIssues: sessionDbConfig.promptOnIntegrityIssues ?? false,
      };

      // Add backend-specific configuration
      if (storageConfig.backend === "sqlite") {
        storageConfig.sqlite = {
          dbPath: sessionDbConfig.dbPath ? this.expandPath(sessionDbConfig.dbPath) : undefined,
        };
      } else if (storageConfig.backend === "postgres") {
        storageConfig.postgres = {
          connectionUrl: sessionDbConfig.connectionString,
        };
      } else if (storageConfig.backend === "json") {
        storageConfig.json = {
          filePath: sessionDbConfig.filePath ? this.expandPath(sessionDbConfig.filePath) : undefined,
        };
      }

      // Create storage backend with integrity checking
      try {
        const result: StorageResult = await createStorageBackendWithIntegrity(storageConfig);
        this.storage = result.storage;
        this.storageWarnings = result.warnings || [];

        // Log integrity check results
        if (result.integrityResult) {
          if (result.integrityResult.isValid) {
            log.debug("Database integrity check passed", {
              backend: storageConfig.backend,
              issues: result.integrityResult.issues.length,
              warnings: result.integrityResult.warnings.length,
            });
          } else {
            log.warn("Database integrity issues detected but continuing", {
              backend: storageConfig.backend,
              issues: result.integrityResult.issues.length,
              warnings: result.integrityResult.warnings.length,
            });
          }
        }

        // Log warnings
        if (this.storageWarnings.length > 0) {
          log.warn("Storage backend created with warnings", {
            warnings: this.storageWarnings,
          });
        }

        // Log auto-migration
        if (result.autoMigrationPerformed) {
          log.info("Database auto-migration was performed during initialization");
        }

      } catch (error) {
        log.error("Failed to create storage backend with integrity checking", {
          error: getErrorMessage(error as any),
          backend: storageConfig.backend,
        });
        throw error;
      }
    }

    return this.storage;
  }

  private expandPath(filePath: string): string {
    // Handle tilde expansion for home directory
    if (filePath.startsWith("~")) {
      return join(homedir(), filePath.slice(1));
    }
    return filePath;
  }

  async listSessions(): Promise<SessionRecord[]> {
    const storage = await this.getStorage();
    return await storage.getEntities();
  }

  async getSession(session: string): Promise<SessionRecord | null> {
    const storage = await this.getStorage();
    return await storage.getEntity(session);
  }

  async getSessionByTaskId(taskId: string): Promise<SessionRecord | null> {
    const storage = await this.getStorage();
    const sessions = await storage.getEntities();

    // Support both "#123" and "123" formats
    const normalizedTaskId = taskId.startsWith("#") ? taskId : `#${taskId}`;
    const alternateTaskId = taskId.startsWith("#") ? taskId.slice(1) : taskId;

    return sessions.find((s) => s.taskId === normalizedTaskId || s.taskId === alternateTaskId) || null;
  }

  async addSession(record: SessionRecord): Promise<void> {
    const storage = await this.getStorage();
    await storage.createEntity(record);
  }

  async updateSession(
    session: string,
    updates: Partial<Omit<SessionRecord, "session">>
  ): Promise<void> {
    const storage = await this.getStorage();
    const result = await storage.updateEntity(session, updates);
    if (!result) {
      throw new Error(`Session '${session}' not found`);
    }
  }

  async deleteSession(session: string): Promise<boolean> {
    const storage = await this.getStorage();
    return await storage.deleteEntity(session);
  }

  async getRepoPath(record: SessionRecord | any): Promise<string> {
    // This method maintains backward compatibility while using the updated storage
    const state = await this.getState();
    return getRepoPathFn(state, record);
  }

  async getSessionWorkdir(sessionName: string): Promise<string> {
    const session = await this.getSession(sessionName);
    if (!session) {
      throw new Error(`Session '${sessionName}' not found`);
    }

    const state = await this.getState();
    return getRepoPathFn(state, session as any);
  }

  private async getState(): Promise<SessionDbState> {
    // Initialize default state when needed
    return initializeSessionDbState();
  }

  async getStorageInfo(): Promise<{ 
    backend: string; 
    location: string; 
    integrityEnabled: boolean;
    warnings: string[];
  }> {
    const storage = await this.getStorage();
    const location = storage.getStorageLocation();
    
    return {
      backend: storage.constructor.name,
      location: location,
      integrityEnabled: true, // Always enabled in merged factory
      warnings: this.storageWarnings,
    };
  }
}

/**
 * Creates a default SessionProvider implementation
 * This factory function provides a consistent way to get a session provider with optional customization
 */
export function createSessionProvider(options?: {
  dbPath?: string;
  useNewBackend?: boolean;
}): SessionProviderInterface {
  // Always use the new configuration-based backend
  return new SessionDbAdapter();
}

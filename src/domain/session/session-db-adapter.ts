/**
 * SessionDbAdapter
 *
 * This adapter implements the SessionProviderInterface using the
 * configuration-based storage backend system with integrity checking.
 * It provides seamless integration with JSON, SQLite, and PostgreSQL storage backends.
 */

import type { SessionProviderInterface, SessionRecord } from "./types";
import { createSessionProviderWithAutoRepair } from "./session-auto-repair-provider";

// Re-export the interface for use in extracted modules
export type { SessionProviderInterface };
import {
  createStorageBackendWithIntegrity,
  type StorageConfig,
  type StorageResult,
} from "../storage/storage-backend-factory";
import type { DatabaseStorage } from "../storage/database-storage";
import type { SessionDbState } from "./session-db";
import {
  normalizeTaskIdForStorage,
  formatTaskIdForDisplay,
  isValidTaskIdInput,
} from "../tasks/task-id-utils";
import { initializeSessionDbState, getRepoPathFn } from "./session-db";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";

import { getConfiguration } from "../configuration/index";
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
      // Get configuration using the custom configuration system
      // Configuration should already be initialized by the CLI entry point
      const config = getConfiguration();
      const sessionDbConfig = config.sessiondb || {};

      // Build storage configuration using values from config system (already defaulted)
      const storageConfig: Partial<StorageConfig> = {
        backend: sessionDbConfig.backend, // No fallback - config system provides defaults
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
        // Use the effective configuration (handles both new nested and legacy flat structure)
        const connectionString =
          sessionDbConfig.postgres?.connectionString || sessionDbConfig.connectionString;
        storageConfig.postgres = {
          connectionString: connectionString,
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

    // Log sessions and task IDs for debugging
    log.debug("Searching for session by task ID", {
      taskId,
      availableSessions: sessions.map((s) => ({ session: s.session, taskId: s.taskId })),
    });

    // TASK 283: Normalize input task ID to storage format for comparison
    const normalizedTaskId = normalizeTaskIdForStorage(taskId);
    if (!normalizedTaskId) {
      log.debug("Invalid task ID format", { taskId });
      return null;
    }

    log.debug("Normalized task ID for lookup", { original: taskId, normalized: normalizedTaskId });

    // Find session where stored task ID matches normalized input
    const matchingSession =
      sessions.find((s) => {
        if (!s.taskId) return false;
        // Normalize the stored task ID for comparison
        const storedNormalized = normalizeTaskIdForStorage(s.taskId);
        log.debug("Comparing task IDs", {
          session: s.session,
          sessionTaskId: s.taskId,
          storedNormalized,
          lookingFor: normalizedTaskId,
          matches: storedNormalized === normalizedTaskId,
        });
        return storedNormalized === normalizedTaskId;
      }) || null;

    if (matchingSession) {
      log.debug("Found matching session", {
        session: matchingSession.session,
        taskId: matchingSession.taskId,
      });
    } else {
      log.debug("No matching session found", {
        taskId,
        normalizedTaskId,
      });
    }

    return matchingSession;
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
export function createSessionProvider(_options?: {
  dbPath?: string;
  useNewBackend?: boolean;
}): SessionProviderInterface {
  log.debug("Creating session provider with auto-repair support");

  // Always use the new configuration-based backend
  const baseProvider = new SessionDbAdapter();

  // Wrap with auto-repair functionality for universal session auto-repair
  const wrappedProvider = wrapWithAutoRepair(baseProvider);

  return wrappedProvider;
}

// Helper function to wrap base provider with auto-repair functionality
function wrapWithAutoRepair(baseProvider: SessionProviderInterface): SessionProviderInterface {
  log.debug("Wrapping session provider with auto-repair functionality");
  return createSessionProviderWithAutoRepair(baseProvider);
}

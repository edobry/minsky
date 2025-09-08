/**
 * SessionDbAdapter
 *
 * This adapter implements the SessionProviderInterface using the
 * PersistenceProvider system for unified database access.
 */

import type { SessionProviderInterface, SessionRecord } from "./types";
import { createSessionProviderWithAutoRepair } from "./session-auto-repair-provider";

// Re-export the interface for use in extracted modules
export type { SessionProviderInterface };
import type { PersistenceProvider } from "../persistence/types";
import { PersistenceService } from "../persistence/service";
import type { DatabaseStorage } from "../storage/database-storage";
import type { SessionDbState } from "./session-db";
import {
  validateQualifiedTaskId,
  formatTaskIdForDisplay,
  isValidTaskIdInput,
} from "../tasks/task-id-utils";
import { initializeSessionDbState, getRepoPathFn } from "./session-db";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";

export class SessionDbAdapter implements SessionProviderInterface {
  private storage: DatabaseStorage<SessionRecord, SessionDbState> | null = null;

  constructor(private readonly persistence: PersistenceProvider) {}

  private async getStorage(): Promise<DatabaseStorage<SessionRecord, SessionDbState>> {
    log.debug("Getting storage from persistence provider");
    if (!this.storage) {
      log.debug("Storage not cached, calling persistence.getStorage()");
      try {
        this.storage = this.persistence.getStorage<SessionRecord, SessionDbState>();
        // Initialize the storage
        await this.storage.initialize();
        log.debug(`Successfully got storage: ${this.storage.constructor.name}`);
      } catch (error) {
        log.error(
          "Failed to get storage from persistence provider:",
          getErrorMessage(error as any)
        );
        log.error("Full error details:", error);
        throw error;
      }
    } else {
      log.debug(`Using cached storage: ${this.storage.constructor.name}`);
    }
    return this.storage;
  }

  // Implementation of the SessionProviderInterface
  async getSession(sessionName: string): Promise<SessionRecord | null> {
    log.debug(`Getting session: ${sessionName}`);
    try {
      const storage = await this.getStorage();
      const result = await storage.getEntity(sessionName);
      return result;
    } catch (error) {
      log.error(`Failed to get session '${sessionName}':`, getErrorMessage(error as any));
      return null;
    }
  }

  async listSessions(): Promise<SessionRecord[]> {
    log.debug("Listing all sessions");
    try {
      log.debug("About to get storage");
      const storage = await this.getStorage();
      log.debug("Got storage, calling getState()");
      const state = await this.getState();
      log.debug(`Got state with ${state.sessions.length} sessions`);
      return state.sessions || [];
    } catch (error) {
      log.error("Failed to list sessions:", getErrorMessage(error as any), error);
      return [];
    }
  }

  async addSession(sessionRecord: SessionRecord): Promise<void> {
    log.debug(`Adding session: ${sessionRecord.session}`);
    try {
      const storage = await this.getStorage();
      await storage.createEntity(sessionRecord);
      log.debug(`Session added successfully: ${sessionRecord.session}`);
    } catch (error) {
      log.error(`Failed to add session '${sessionRecord.session}':`, getErrorMessage(error as any));
      throw error;
    }
  }

  async updateSession(sessionName: string, updates: Partial<SessionRecord>): Promise<void> {
    log.debug(`Updating session: ${sessionName}`);
    try {
      const storage = await this.getStorage();
      const result = await storage.updateEntity(sessionName, updates);
      if (!result) {
        throw new Error(`Session '${sessionName}' not found`);
      }
      log.debug(`Session updated successfully: ${sessionName}`);
    } catch (error) {
      log.error(`Failed to update session '${sessionName}':`, getErrorMessage(error as any));
      throw error;
    }
  }

  async deleteSession(sessionName: string): Promise<boolean> {
    log.debug(`Deleting session: ${sessionName}`);
    try {
      const storage = await this.getStorage();
      const deleted = await storage.deleteEntity(sessionName);
      if (deleted) {
        log.debug(`Session deleted successfully: ${sessionName}`);
      } else {
        log.debug(`Session not found: ${sessionName}`);
      }
      return deleted;
    } catch (error) {
      log.error(`Failed to delete session '${sessionName}':`, getErrorMessage(error as any));
      return false;
    }
  }

  async doesSessionExist(sessionName: string): Promise<boolean> {
    try {
      const storage = await this.getStorage();
      return await storage.entityExists(sessionName);
    } catch (error) {
      log.error(
        `Error checking if session exists '${sessionName}':`,
        getErrorMessage(error as any)
      );
      return false;
    }
  }

  async addTaskToSession(sessionName: string, taskId: string): Promise<boolean> {
    try {
      // Validate task ID format
      if (!isValidTaskIdInput(taskId)) {
        log.error(`Invalid task ID format: ${taskId}. Must be either mt#123, md#123, or 123`);
        return false;
      }

      // Normalize task ID to qualified format (mt#123 or md#123)
      let validatedTaskId: string;
      try {
        validatedTaskId = validateQualifiedTaskId(taskId);
      } catch (error) {
        log.error(`Task ID validation failed: ${getErrorMessage(error as any)}`);
        return false;
      }

      // Get current session
      const session = await this.getSession(sessionName);
      if (!session) {
        log.error(`Session not found: ${sessionName}`);
        return false;
      }

      // Update session with new task ID
      await this.updateSession(sessionName, {
        taskId: validatedTaskId,
      });

      log.debug(`Task ${formatTaskIdForDisplay(validatedTaskId)} added to session ${sessionName}`);
      return true;
    } catch (error) {
      log.error(`Failed to add task to session '${sessionName}':`, getErrorMessage(error as any));
      return false;
    }
  }

  async setSessionRepo(
    sessionName: string,
    repoPath: string,
    repoName?: string,
    repoUrl?: string
  ): Promise<boolean> {
    try {
      const updates: Partial<SessionRecord> = { repoPath };

      if (repoName !== undefined) {
        updates.repoName = repoName;
      }
      if (repoUrl !== undefined) {
        updates.repoUrl = repoUrl;
      }

      await this.updateSession(sessionName, updates);

      log.debug(
        `Repository set for session ${sessionName}: ${repoPath}${repoName ? ` (${repoName})` : ""}`
      );
      return true;
    } catch (error) {
      log.error(`Failed to set repo for session '${sessionName}':`, getErrorMessage(error as any));
      return false;
    }
  }

  async findSessionsForRepo(repoPath: string): Promise<SessionRecord[]> {
    try {
      const sessions = await this.listSessions();
      const repoPathFn = await getRepoPathFn();

      return sessions.filter((session) => {
        const sessionRepoPath = repoPathFn(session);
        return sessionRepoPath === repoPath;
      });
    } catch (error) {
      log.error(`Failed to find sessions for repo '${repoPath}':`, getErrorMessage(error as any));
      return [];
    }
  }

  async getSessionByTaskId(taskId: string): Promise<SessionRecord | null> {
    try {
      // Validate and normalize task ID
      let validatedTaskId: string | null;
      try {
        validatedTaskId = validateQualifiedTaskId(taskId);
      } catch (error) {
        log.error(`Task ID validation failed: ${getErrorMessage(error as any)}`);
        return null;
      }

      if (!validatedTaskId) {
        return null;
      }

      const state = await this.getState();
      const sessions = state.sessions;
      log.debug(`Looking for taskId: '${validatedTaskId}' in ${sessions.length} sessions`);
      sessions.forEach((session, i) => {
        log.debug(`Session ${i}: taskId='${session.taskId}', session='${session.session}'`);
      });

      const found = sessions.find((session) => session.taskId === validatedTaskId);
      log.debug(`Found session: ${found ? "YES" : "NO"}`);
      return found || null;
    } catch (error) {
      log.error(`Failed to find session for task '${taskId}':`, getErrorMessage(error as any));
      return null;
    }
  }

  async getSessionsForTask(taskId: string): Promise<SessionRecord[]> {
    try {
      // Validate and normalize task ID
      let validatedTaskId: string;
      try {
        validatedTaskId = validateQualifiedTaskId(taskId);
      } catch (error) {
        log.error(`Task ID validation failed: ${getErrorMessage(error as any)}`);
        return [];
      }

      const sessions = await this.listSessions();
      return sessions.filter((session) => session.taskId === validatedTaskId);
    } catch (error) {
      log.error(`Failed to find sessions for task '${taskId}':`, getErrorMessage(error as any));
      return [];
    }
  }

  async getSessionWorkdir(sessionName: string): Promise<string> {
    try {
      const storage = await this.getStorage();
      const stateResult = await storage.readState();

      if (!stateResult.success || !stateResult.data) {
        throw new Error("Failed to read session state");
      }

      const { getSessionWorkdirFn } = await import("./session-db");
      const workdir = getSessionWorkdirFn(stateResult.data, sessionName);

      if (!workdir) {
        throw new Error(`Session '${sessionName}' not found or has no working directory`);
      }

      return workdir;
    } catch (error) {
      log.error(
        `Failed to get session workdir for '${sessionName}':`,
        getErrorMessage(error as any)
      );
      throw error;
    }
  }

  async clearSessionTask(sessionName: string): Promise<boolean> {
    try {
      await this.updateSession(sessionName, { taskId: undefined });
      log.debug(`Task cleared from session: ${sessionName}`);
      return true;
    } catch (error) {
      log.error(
        `Failed to clear task from session '${sessionName}':`,
        getErrorMessage(error as any)
      );
      return false;
    }
  }

  async getRepoPath(record: SessionRecord): Promise<string> {
    try {
      // Use the existing repoPath from the session record
      if (record.repoPath) {
        return record.repoPath;
      }

      // Fallback: use the session-db getRepoPathFn utility
      const repoPath = getRepoPathFn(record);
      return repoPath;
    } catch (error) {
      log.error(
        `Failed to get repo path for session '${record.session}':`,
        getErrorMessage(error as any)
      );
      throw error;
    }
  }

  // Internal helper methods
  private async getState(): Promise<SessionDbState> {
    try {
      const storage = await this.getStorage();
      log.debug("About to call storage.readState()");
      const result = await storage.readState();
      log.debug(`readState result: success=${result.success}, data=${!!result.data}`);
      if (result.success && result.data) {
        log.debug(`readState returned ${result.data.sessions.length} sessions`);
        return result.data;
      }
      log.warn("Failed to read session state from storage, initializing empty state");
      log.debug(
        `Result details: success=${result.success}, data=${!!result.data}, error=${result.error?.message}`
      );
      return initializeSessionDbState();
    } catch (error) {
      log.error("Error reading session state:", getErrorMessage(error as any), error);
      return initializeSessionDbState();
    }
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
      backend: this.persistence.constructor.name,
      location: this.persistence.getConnectionInfo(),
      integrityEnabled: false, // No integrity checking in new architecture
      warnings: [],
    };
  }
}

/**
 * Creates a default SessionProvider implementation
 * This factory function provides a consistent way to get a session provider with optional customization
 */
export async function createSessionProvider(_options?: {
  dbPath?: string;
  useNewBackend?: boolean;
}): Promise<SessionProviderInterface> {
  log.debug("Creating session provider with auto-repair support");

  // Get PersistenceProvider from PersistenceService
  log.debug(`PersistenceService initialized: ${PersistenceService.isInitialized()}`);
  if (!PersistenceService.isInitialized()) {
    log.debug("Initializing PersistenceService...");
    try {
      await PersistenceService.initialize();
      log.debug("PersistenceService initialization completed");
    } catch (error) {
      log.error("PersistenceService initialization failed:", getErrorMessage(error as any), error);
      throw error;
    }
  }
  log.debug("Getting provider from PersistenceService...");
  const provider = PersistenceService.getProvider();
  log.debug("Got provider, creating SessionDbAdapter...");
  const baseProvider = new SessionDbAdapter(provider);

  // Wrap with auto-repair functionality for universal session auto-repair
  const wrappedProvider = wrapWithAutoRepair(baseProvider);

  return wrappedProvider;
}

// Helper function to wrap base provider with auto-repair functionality
function wrapWithAutoRepair(baseProvider: SessionProviderInterface): SessionProviderInterface {
  return createSessionProviderWithAutoRepair(baseProvider);
}

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
    if (!this.storage) {
      this.storage = this.persistence.getStorage<SessionRecord, SessionDbState>();
    }
    return this.storage;
  }

  // Implementation of the SessionProviderInterface
  async getSession(sessionName: string): Promise<SessionRecord | null> {
    log.debug(`Getting session: ${sessionName}`);
    try {
      const storage = await this.getStorage();
      const result = await storage.get(sessionName);
      return result.success ? result.data : null;
    } catch (error) {
      log.error(`Failed to get session '${sessionName}':`, getErrorMessage(error as any));
      return null;
    }
  }

  async listSessions(): Promise<SessionRecord[]> {
    log.debug("Listing all sessions");
    try {
      const storage = await this.getStorage();
      const state = await this.getState();
      return state.sessions || [];
    } catch (error) {
      log.error("Failed to list sessions:", getErrorMessage(error as any));
      return [];
    }
  }

  async createSession(sessionRecord: SessionRecord): Promise<void> {
    log.debug(`Creating session: ${sessionRecord.session}`);
    try {
      const storage = await this.getStorage();
      await storage.save(sessionRecord.session, sessionRecord);
      log.debug(`Session created successfully: ${sessionRecord.session}`);
    } catch (error) {
      log.error(
        `Failed to create session '${sessionRecord.session}':`,
        getErrorMessage(error as any)
      );
      throw error;
    }
  }

  async updateSession(sessionName: string, updates: Partial<SessionRecord>): Promise<void> {
    log.debug(`Updating session: ${sessionName}`);
    try {
      const storage = await this.getStorage();
      await storage.update(sessionName, updates);
      log.debug(`Session updated successfully: ${sessionName}`);
    } catch (error) {
      log.error(`Failed to update session '${sessionName}':`, getErrorMessage(error as any));
      throw error;
    }
  }

  async deleteSession(sessionName: string): Promise<void> {
    log.debug(`Deleting session: ${sessionName}`);
    try {
      const storage = await this.getStorage();
      await storage.delete(sessionName);
      log.debug(`Session deleted successfully: ${sessionName}`);
    } catch (error) {
      log.error(`Failed to delete session '${sessionName}':`, getErrorMessage(error as any));
      throw error;
    }
  }

  async doesSessionExist(sessionName: string): Promise<boolean> {
    try {
      const session = await this.getSession(sessionName);
      return session !== null;
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
      let validatedTaskId: string;
      try {
        validatedTaskId = validateQualifiedTaskId(taskId);
      } catch (error) {
        log.error(`Task ID validation failed: ${getErrorMessage(error as any)}`);
        return null;
      }

      const sessions = await this.listSessions();
      return sessions.find((session) => session.taskId === validatedTaskId) || null;
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

  // Internal helper methods
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
  if (!PersistenceService.isInitialized()) {
    await PersistenceService.initialize();
  }
  const provider = PersistenceService.getProvider();
  const baseProvider = new SessionDbAdapter(provider);

  // Wrap with auto-repair functionality for universal session auto-repair
  const wrappedProvider = wrapWithAutoRepair(baseProvider);

  return wrappedProvider;
}

// Helper function to wrap base provider with auto-repair functionality
function wrapWithAutoRepair(baseProvider: SessionProviderInterface): SessionProviderInterface {
  return createSessionProviderWithAutoRepair(baseProvider);
}

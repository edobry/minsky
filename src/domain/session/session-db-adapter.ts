/**
 * SessionDbAdapter
 *
 * This adapter implements the SessionProviderInterface using the
 * PersistenceProvider system for unified database access.
 */

import { injectable, inject } from "tsyringe";
import type { SessionProviderInterface, SessionRecord } from "./types";
import type { SessionListOptions } from "./types";
import { createSessionProviderWithAutoRepair } from "./session-auto-repair-provider";

// Re-export the interface for use in extracted modules
export type { SessionProviderInterface };
import type { PersistenceProvider } from "../persistence/types";
import type { DatabaseStorage } from "../storage/database-storage";
import type { SessionDbState } from "./session-db";
import {
  validateQualifiedTaskId,
  formatTaskIdForDisplay,
  isValidTaskIdInput,
} from "../tasks/task-id-utils";
import { getRepoPathFn } from "./session-db";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";

@injectable()
export class SessionDbAdapter implements SessionProviderInterface {
  private storage: DatabaseStorage<SessionRecord, SessionDbState> | null = null;

  constructor(@inject("persistence") private readonly persistence: PersistenceProvider) {}

  private async getStorage(): Promise<DatabaseStorage<SessionRecord, SessionDbState>> {
    log.debug("Getting storage from persistence provider");
    if (!this.storage) {
      log.debug("Storage not cached, calling persistence.getStorage()");
      try {
        const storage = this.persistence.getStorage();
        // Initialize before caching — if init fails, cache stays null so retries re-attempt
        await storage.initialize();
        this.storage = storage;
        log.debug(`Successfully got storage: ${this.storage.constructor.name}`);
      } catch (error) {
        log.error(
          `Failed to get storage from persistence provider: ${getErrorMessage(error)}`,
          error instanceof Error ? error : { error: String(error) }
        );
        throw error;
      }
    } else {
      log.debug(`Using cached storage: ${this.storage.constructor.name}`);
    }
    return this.storage;
  }

  // Implementation of the SessionProviderInterface
  async getSession(sessionId: string): Promise<SessionRecord | null> {
    log.debug(`Getting session: ${sessionId}`);
    const storage = await this.getStorage();
    return await storage.getEntity(sessionId);
  }

  async listSessions(options?: SessionListOptions): Promise<SessionRecord[]> {
    log.debug(
      options ? `Listing sessions with options: ${JSON.stringify(options)}` : "Listing all sessions"
    );
    if (options) {
      // Push pagination/ordering/filters down to the storage layer to avoid
      // loading every row into memory just to slice the result.
      const storage = await this.getStorage();
      const sessions = await storage.getEntities(options);
      log.debug(`Got ${sessions.length} sessions from storage with options`);
      return sessions;
    }
    const state = await this.getState();
    log.debug(`Got state with ${state.sessions.length} sessions`);
    return state.sessions || [];
  }

  async addSession(sessionRecord: SessionRecord): Promise<void> {
    log.debug(`Adding session: ${sessionRecord.sessionId}`);
    try {
      const storage = await this.getStorage();
      await storage.createEntity(sessionRecord);
      log.debug(`Session added successfully: ${sessionRecord.sessionId}`);
    } catch (error) {
      log.error(`Failed to add session '${sessionRecord.sessionId}': ${getErrorMessage(error)}`);
      throw error;
    }
  }

  async updateSession(sessionId: string, updates: Partial<SessionRecord>): Promise<void> {
    log.debug(`Updating session: ${sessionId}`);
    try {
      const storage = await this.getStorage();
      const result = await storage.updateEntity(sessionId, updates);
      if (!result) {
        throw new Error(`Session '${sessionId}' not found`);
      }
      log.debug(`Session updated successfully: ${sessionId}`);
    } catch (error) {
      log.error(`Failed to update session '${sessionId}': ${getErrorMessage(error)}`);
      throw error;
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    log.debug(`Deleting session: ${sessionId}`);
    // Note: we do NOT wrap this in a catch-all.  Storage errors (permission denied,
    // corruption, etc.) must propagate so callers can surface them to the user.
    // Returning `false` is only appropriate for "session not found" — a legitimate
    // outcome for idempotent delete — which the underlying storage signals by
    // returning `false` from `deleteEntity` rather than throwing.
    const storage = await this.getStorage();
    const deleted = await storage.deleteEntity(sessionId);
    if (deleted) {
      log.debug(`Session deleted successfully: ${sessionId}`);
    } else {
      log.debug(`Session not found for deletion: ${sessionId}`);
    }
    return deleted;
  }

  async doesSessionExist(sessionId: string): Promise<boolean> {
    const storage = await this.getStorage();
    return await storage.entityExists(sessionId);
  }

  async addTaskToSession(sessionId: string, taskId: string): Promise<boolean> {
    // Validate task ID format
    if (!isValidTaskIdInput(taskId)) {
      log.warn(`Invalid task ID format: ${taskId}. Must be either mt#123, md#123, or 123`);
      return false;
    }

    // Normalize task ID to qualified format (mt#123 or md#123)
    let validatedTaskId: string;
    try {
      validatedTaskId = validateQualifiedTaskId(taskId) ?? taskId;
    } catch (error) {
      log.warn(`Task ID validation failed: ${getErrorMessage(error)}`);
      return false;
    }

    // Get current session
    const session = await this.getSession(sessionId);
    if (!session) {
      log.error(`Session not found: ${sessionId}`);
      return false;
    }

    // Update session with new task ID
    await this.updateSession(sessionId, {
      taskId: validatedTaskId,
    });

    log.debug(`Task ${formatTaskIdForDisplay(validatedTaskId)} added to session ${sessionId}`);
    return true;
  }

  async setSessionRepo(
    sessionId: string,
    repoPath: string,
    repoName?: string,
    repoUrl?: string
  ): Promise<boolean> {
    const updates: Partial<SessionRecord> = { repoPath };

    if (repoName !== undefined) {
      updates.repoName = repoName;
    }
    if (repoUrl !== undefined) {
      updates.repoUrl = repoUrl;
    }

    await this.updateSession(sessionId, updates);

    log.debug(
      `Repository set for session ${sessionId}: ${repoPath}${repoName ? ` (${repoName})` : ""}`
    );
    return true;
  }

  async findSessionsForRepo(repoPath: string): Promise<SessionRecord[]> {
    const sessions = await this.listSessions();
    return sessions.filter((session) => session.repoPath === repoPath);
  }

  async getSessionByTaskId(taskId: string): Promise<SessionRecord | null> {
    // Validate and normalize task ID
    let validatedTaskId: string | null;
    try {
      validatedTaskId = validateQualifiedTaskId(taskId);
    } catch (error) {
      log.warn(`Task ID validation failed: ${getErrorMessage(error)}`);
      return null;
    }

    if (!validatedTaskId) {
      return null;
    }

    const state = await this.getState();
    const sessions = state.sessions;
    log.debug(`Looking for taskId: '${validatedTaskId}' in ${sessions.length} sessions`);

    const found = sessions.find((session) => session.taskId === validatedTaskId);
    log.debug(`Found session: ${found ? "YES" : "NO"}`);
    return found || null;
  }

  async getSessionsForTask(taskId: string): Promise<SessionRecord[]> {
    // Validate and normalize task ID
    let validatedTaskId: string;
    try {
      validatedTaskId = validateQualifiedTaskId(taskId) ?? taskId;
    } catch (error) {
      log.warn(`Task ID validation failed: ${getErrorMessage(error)}`);
      return [];
    }

    const sessions = await this.listSessions();
    return sessions.filter((session) => session.taskId === validatedTaskId);
  }

  async getSessionWorkdir(sessionId: string): Promise<string> {
    try {
      const storage = await this.getStorage();
      const stateResult = await storage.readState();

      if (!stateResult.success || !stateResult.data) {
        throw new Error("Failed to read session state");
      }

      const { getSessionWorkdirFn } = await import("./session-db");
      const workdir = getSessionWorkdirFn(stateResult.data, sessionId);

      if (!workdir) {
        throw new Error(`Session '${sessionId}' not found or has no working directory`);
      }

      return workdir;
    } catch (error) {
      log.error(`Failed to get session workdir for '${sessionId}': ${getErrorMessage(error)}`);
      throw error;
    }
  }

  async clearSessionTask(sessionId: string): Promise<boolean> {
    await this.updateSession(sessionId, { taskId: undefined });
    log.debug(`Task cleared from session: ${sessionId}`);
    return true;
  }

  async getRepoPath(record: SessionRecord): Promise<string> {
    try {
      // Use the existing repoPath from the session record
      if (record.repoPath) {
        return record.repoPath;
      }

      // Fallback: use the session-db getRepoPathFn utility with state
      const storage = await this.getStorage();
      const state = await storage.readState();
      if (!state.success || !state.data) {
        throw new Error("Failed to read session database state");
      }
      return getRepoPathFn(state.data, record);
    } catch (error) {
      log.error(
        `Failed to get repo path for session '${record.sessionId}': ${getErrorMessage(error)}`
      );
      throw error;
    }
  }

  // Internal helper methods
  private async getState(): Promise<SessionDbState> {
    const storage = await this.getStorage();
    log.debug("About to call storage.readState()");
    const result = await storage.readState();
    log.debug(`readState result: success=${result.success}, data=${!!result.data}`);
    if (result.success && result.data) {
      log.debug(`readState returned ${result.data.sessions.length} sessions`);
      return result.data;
    }
    // Propagate storage failures instead of hiding them behind empty state
    const errorMsg = result.error?.message || "Unknown storage error";
    throw new Error(`Failed to read session state: ${errorMsg}`);
  }

  async getStorageInfo(): Promise<{
    backend: string;
    location: string;
    integrityEnabled: boolean;
    warnings: string[];
  }> {
    const storage = await this.getStorage();
    const _location = storage.getStorageLocation();

    return {
      backend: this.persistence.constructor.name,
      location: this.persistence.getConnectionInfo(),
      integrityEnabled: false, // No integrity checking in new architecture
      warnings: [],
    };
  }
}

/**
 * Dependencies for createSessionProvider, injectable for testing
 */
export interface CreateSessionProviderDeps {
  persistenceService: {
    isInitialized: () => boolean;
    getProvider: () => PersistenceProvider;
  };
}

/**
 * Creates a default SessionProvider implementation.
 *
 * Accepts either a `CreateSessionProviderDeps` object (legacy) or a raw
 * `PersistenceProvider` directly. Callers with container access should
 * pass the persistence provider explicitly.
 */
export async function createSessionProvider(
  _options?: {
    dbPath?: string;
    useNewBackend?: boolean;
  },
  deps?: CreateSessionProviderDeps | PersistenceProvider
): Promise<SessionProviderInterface> {
  if (!deps) {
    throw new Error(
      "Session provider unavailable: no persistence dependency provided. " +
        "This usually means the DI container was not initialized before tool " +
        "registration. If running as an MCP server, restart with /mcp."
    );
  }

  // Normalize: accept either a raw PersistenceProvider or the legacy deps wrapper
  const provider: PersistenceProvider =
    typeof (deps as CreateSessionProviderDeps).persistenceService === "object"
      ? (deps as CreateSessionProviderDeps).persistenceService.getProvider()
      : (deps as PersistenceProvider);

  log.debug("Creating session provider with auto-repair support");
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

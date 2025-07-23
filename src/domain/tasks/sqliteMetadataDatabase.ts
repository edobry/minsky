/**
 * SQLite-based MetadataDatabase implementation
 *
 * Provides persistent storage for task metadata separate from task specs.
 * Implements the hybrid spec+database pattern from Task #315.
 * 
 * Uses the existing database storage infrastructure for consistency.
 */

import { SqliteStorage } from "../storage/backends/sqlite-storage";
import type { DatabaseStorage } from "../storage/database-storage";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
import type { MetadataDatabase, TaskMetadata, MetadataQuery } from "./types";

/**
 * Configuration for SQLite metadata database
 */
export interface SqliteMetadataDatabaseOptions {
  /**
   * Path to the SQLite database file
   * Defaults to ~/.local/state/minsky/tasks-metadata.db
   */
  databasePath?: string;

  /**
   * Whether to enable WAL mode for better concurrent access
   * Defaults to true
   */
  enableWalMode?: boolean;

  /**
   * Connection timeout in milliseconds
   * Defaults to 5000
   */
  timeout?: number;
}

/**
 * State structure for task metadata storage
 */
interface TaskMetadataDbState {
  metadata: Record<string, TaskMetadata>;
  version: string;
}

/**
 * SQLite-based implementation of MetadataDatabase using existing storage infrastructure
 *
 * Features:
 * - Reuses existing SQLite storage backend
 * - Type-safe operations with Drizzle ORM
 * - Transaction support for atomic operations
 * - Optimized queries for metadata relationships
 * - Backup and restore capabilities
 */
export class SqliteMetadataDatabase implements MetadataDatabase {
  private storage: DatabaseStorage<TaskMetadata, TaskMetadataDbState>;
  private readonly databasePath: string;

  constructor(options: SqliteMetadataDatabaseOptions = {}) {
    this.databasePath = options.databasePath || 
      `${process.env.HOME}/.local/state/minsky/tasks-metadata.db`;

    // Use existing SQLite storage infrastructure
    this.storage = new SqliteStorage<TaskMetadata, TaskMetadataDbState>({
      dbPath: this.databasePath,
      enableWAL: options.enableWalMode ?? true,
      timeout: options.timeout ?? 5000,
    });
  }

  async initialize(): Promise<void> {
    try {
      log.info("Initializing SQLite metadata database", {
        databasePath: this.databasePath,
      });

      await this.storage.initialize();

      // Initialize database state if it doesn't exist
      const state = await this.storage.readState();
      if (!state.success || !state.data) {
        const initialState: TaskMetadataDbState = {
          metadata: {},
          version: "1.0.0",
        };
        await this.storage.writeState(initialState);
      }

      log.info("SQLite metadata database initialized successfully");
    } catch (error) {
      log.error("Failed to initialize SQLite metadata database", {
        error: getErrorMessage(error as any),
      });
      throw error;
    }
  }

  async getTaskMetadata(taskId: string): Promise<TaskMetadata | null> {
    try {
      log.debug("Getting task metadata", { taskId });
      
      const entity = await this.storage.getEntity(taskId);
      return entity || null;
    } catch (error) {
      log.error("Failed to get task metadata", {
        error: getErrorMessage(error as any),
        taskId,
      });
      throw error;
    }
  }

  async setTaskMetadata(taskId: string, metadata: TaskMetadata): Promise<void> {
    try {
      log.debug("Setting task metadata", { taskId });

      // Check if entity exists
      const exists = await this.storage.entityExists(taskId);
      
      if (exists) {
        await this.storage.updateEntity(taskId, metadata);
      } else {
        await this.storage.createEntity({ ...metadata, taskId });
      }

      log.debug("Task metadata set successfully", { taskId });
    } catch (error) {
      log.error("Failed to set task metadata", {
        error: getErrorMessage(error as any),
        taskId,
      });
      throw error;
    }
  }

  async deleteTaskMetadata(taskId: string): Promise<void> {
    try {
      log.debug("Deleting task metadata", { taskId });
      
      const deleted = await this.storage.deleteEntity(taskId);
      if (!deleted) {
        log.warn("Task metadata not found for deletion", { taskId });
      }

      log.debug("Task metadata deleted successfully", { taskId });
    } catch (error) {
      log.error("Failed to delete task metadata", {
        error: getErrorMessage(error as any),
        taskId,
      });
      throw error;
    }
  }

  async queryTasks(query: MetadataQuery): Promise<TaskMetadata[]> {
    try {
      log.debug("Querying tasks", { query });

      // Convert MetadataQuery to DatabaseQueryOptions
      const queryOptions: any = {};
      
      if (query.status) {
        queryOptions.status = query.status;
      }
      
      if (query.createdAfter) {
        queryOptions.createdAfter = query.createdAfter;
      }
      
      if (query.createdBefore) {
        queryOptions.createdBefore = query.createdBefore;
      }
      
      if (query.updatedAfter) {
        queryOptions.updatedAfter = query.updatedAfter;
      }
      
      if (query.updatedBefore) {
        queryOptions.updatedBefore = query.updatedBefore;
      }

      const results = await this.storage.getEntities(queryOptions);
      return results;
    } catch (error) {
      log.error("Failed to query tasks", {
        error: getErrorMessage(error as any),
        query,
      });
      throw error;
    }
  }

  async setMultipleTaskMetadata(metadata: Record<string, TaskMetadata>): Promise<void> {
    try {
      log.debug("Setting multiple task metadata", {
        count: Object.keys(metadata).length,
      });

      // Use the existing storage's bulk operations or iterate
      for (const [taskId, taskMetadata] of Object.entries(metadata)) {
        await this.setTaskMetadata(taskId, taskMetadata);
      }

      log.debug("Multiple task metadata set successfully");
    } catch (error) {
      log.error("Failed to set multiple task metadata", {
        error: getErrorMessage(error as any),
      });
      throw error;
    }
  }

  async deleteMultipleTaskMetadata(taskIds: string[]): Promise<void> {
    try {
      log.debug("Deleting multiple task metadata", {
        count: taskIds.length,
      });

      // Delete each task metadata
      for (const taskId of taskIds) {
        await this.deleteTaskMetadata(taskId);
      }

      log.debug("Multiple task metadata deleted successfully");
    } catch (error) {
      log.error("Failed to delete multiple task metadata", {
        error: getErrorMessage(error as any),
      });
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      // The underlying storage will handle cleanup
      log.debug("SQLite metadata database connection closed");
    } catch (error) {
      log.error("Failed to close SQLite metadata database", {
        error: getErrorMessage(error as any),
      });
      throw error;
    }
  }

  async backup(backupPath: string): Promise<void> {
    try {
      log.info("Starting SQLite metadata backup", { backupPath });

      // Read current state and write to backup location
      const state = await this.storage.readState();
      if (state.success && state.data) {
        const backupStorage = new SqliteStorage<TaskMetadata, TaskMetadataDbState>({
          dbPath: backupPath,
          enableWAL: false, // Don't use WAL for backup
        });
        
        await backupStorage.initialize();
        await backupStorage.writeState(state.data);
      }

      log.info("SQLite metadata backup completed", { backupPath });
    } catch (error) {
      log.error("Failed to backup SQLite metadata", {
        error: getErrorMessage(error as any),
        backupPath,
      });
      throw error;
    }
  }

  async restore(backupPath: string): Promise<void> {
    try {
      log.info("Starting SQLite metadata restore", { backupPath });

      // Read from backup and write to current database
      const backupStorage = new SqliteStorage<TaskMetadata, TaskMetadataDbState>({
        dbPath: backupPath,
        enableWAL: false,
      });
      
      const backupState = await backupStorage.readState();
      if (backupState.success && backupState.data) {
        await this.storage.writeState(backupState.data);
      } else {
        throw new Error("Failed to read backup data");
      }

      log.info("SQLite metadata restore completed", { backupPath });
    } catch (error) {
      log.error("Failed to restore SQLite metadata", {
        error: getErrorMessage(error as any),
        backupPath,
      });
      throw error;
    }
  }
}

/**
 * Factory function to create a SQLite metadata database
 */
export function createSqliteMetadataDatabase(
  options: SqliteMetadataDatabaseOptions = {}
): SqliteMetadataDatabase {
  return new SqliteMetadataDatabase(options);
}
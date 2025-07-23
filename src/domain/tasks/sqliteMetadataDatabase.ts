/**
 * SQLite-based MetadataDatabase implementation
 *
 * Provides persistent storage for task metadata separate from task specs.
 * Implements the hybrid spec+database pattern from Task #315.
 */

import Database from "bun:sqlite";
import { join } from "path";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
import type { MetadataDatabase, TaskMetadata, MetadataQuery } from "./types";

/**
 * Configuration for SQLite metadata database
 */
export interface SqliteMetadataDatabaseOptions {
  /**
   * Path to the SQLite database file
   * Defaults to ~/.local/state/minsky/tasks.db
   */
  databasePath?: string;

  /**
   * Whether to enable WAL mode for better concurrent access
   * Defaults to true
   */
  enableWalMode?: boolean;

  /**
   * Whether to enable foreign key constraints
   * Defaults to true
   */
  enableForeignKeys?: boolean;
}

/**
 * SQLite-based implementation of MetadataDatabase
 *
 * Features:
 * - Persistent storage using SQLite
 * - Transaction support for atomic operations
 * - Optimized queries for metadata relationships
 * - Backup and restore capabilities
 */
export class SqliteMetadataDatabase implements MetadataDatabase {
  private db: Database | null = null;
  private readonly databasePath: string;
  private readonly options: Required<SqliteMetadataDatabaseOptions>;
  private initialized = false;

  constructor(options: SqliteMetadataDatabaseOptions = {}) {
    this.databasePath = options.databasePath || this.getDefaultDatabasePath();
    this.options = {
      databasePath: this.databasePath,
      enableWalMode: options.enableWalMode ?? true,
      enableForeignKeys: options.enableForeignKeys ?? true,
    };
  }

  /**
   * Get the default database path
   */
  private getDefaultDatabasePath(): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp";
    return join(homeDir, ".local", "state", "minsky", "tasks.db");
  }

  /**
   * Initialize the database and create tables
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // Ensure directory exists
      const dbDir = join(this.databasePath, "..");
      if (!existsSync(dbDir)) {
        await mkdir(dbDir, { recursive: true });
      }

      // Open database
      this.db = new Database(this.databasePath);

      // Configure database
      if (this.options.enableWalMode) {
        this.db.run("PRAGMA journal_mode = WAL");
      }

      if (this.options.enableForeignKeys) {
        this.db.run("PRAGMA foreign_keys = ON");
      }

      // Optimize for performance
      this.db.run("PRAGMA synchronous = NORMAL");
      this.db.run("PRAGMA cache_size = 10000");
      this.db.run("PRAGMA temp_store = memory");

      // Create tables
      this.createTables();

      // Disable foreign key checks for bulk operations
      this.db.run("PRAGMA defer_foreign_keys = ON");

      this.initialized = true;
      log.debug("SQLite metadata database initialized", {
        path: this.databasePath,
      });
    } catch (error) {
      log.error("Failed to initialize SQLite metadata database", {
        path: this.databasePath,
        error: getErrorMessage(error as any),
      });
      throw error;
    }
  }

  /**
   * Create database tables
   */
  private createTables(): void {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    // Main task metadata table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_metadata (
        task_id TEXT PRIMARY KEY,
        created_at TEXT,
        updated_at TEXT,
        parent_task TEXT,
        original_requirements TEXT,
        ai_enhanced BOOLEAN,
        creation_context TEXT,
        custom_data TEXT
      )
    `);

    // Subtasks relationship table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_subtasks (
        parent_id TEXT NOT NULL,
        subtask_id TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (parent_id, subtask_id)
      )
    `);

    // Dependencies table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_dependencies (
        task_id TEXT NOT NULL,
        dependency_id TEXT NOT NULL,
        dependency_type TEXT NOT NULL CHECK (dependency_type IN ('prerequisite', 'optional', 'related')),
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (task_id, dependency_id, dependency_type)
      )
    `);

    // Create indexes for performance
    this.db.run("CREATE INDEX IF NOT EXISTS idx_parent_task ON task_metadata(parent_task)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_ai_enhanced ON task_metadata(ai_enhanced)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_subtasks_parent ON task_subtasks(parent_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_subtasks_child ON task_subtasks(subtask_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_deps_task ON task_dependencies(task_id)");
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_deps_dependency ON task_dependencies(dependency_id)"
    );
    this.db.run("CREATE INDEX IF NOT EXISTS idx_deps_type ON task_dependencies(dependency_type)");
  }

  /**
   * Get task metadata by ID
   */
  async getTaskMetadata(taskId: string): Promise<TaskMetadata | null> {
    await this.initialize();

    if (!this.db) {
      throw new Error("Database not initialized");
    }

    try {
      // Get main metadata
      const metadataQuery = this.db.prepare(`
        SELECT * FROM task_metadata WHERE task_id = ?
      `);
      const metadata = metadataQuery.get(taskId) as any;

      if (!metadata) {
        return null;
      }

      // Get subtasks
      const subtasksQuery = this.db.prepare(`
        SELECT subtask_id FROM task_subtasks WHERE parent_id = ?
      `);
      const subtasks = subtasksQuery.all(taskId) as any[];

      // Get dependencies
      const depsQuery = this.db.prepare(`
        SELECT dependency_id, dependency_type FROM task_dependencies WHERE task_id = ?
      `);
      const dependencies = depsQuery.all(taskId) as any[];

      // Build result
      const result: TaskMetadata = {
        createdAt: metadata.created_at,
        updatedAt: metadata.updated_at,
        parentTask: metadata.parent_task,
        originalRequirements: metadata.original_requirements,
        aiEnhanced: metadata.ai_enhanced === 1,
        creationContext: metadata.creation_context,
        subtasks: subtasks.map((row) => row.subtask_id),
        dependencies: {
          prerequisite: dependencies
            .filter((d) => d.dependency_type === "prerequisite")
            .map((d) => d.dependency_id),
          optional: dependencies
            .filter((d) => d.dependency_type === "optional")
            .map((d) => d.dependency_id),
          related: dependencies
            .filter((d) => d.dependency_type === "related")
            .map((d) => d.dependency_id),
        },
        custom: metadata.custom_data ? JSON.parse(metadata.custom_data) : undefined,
      };

      return result;
    } catch (error) {
      log.error("Failed to get task metadata", {
        taskId,
        error: getErrorMessage(error as any),
      });
      throw error;
    }
  }

  /**
   * Set task metadata by ID
   */
  async setTaskMetadata(taskId: string, metadata: TaskMetadata): Promise<void> {
    await this.initialize();

    if (!this.db) {
      throw new Error("Database not initialized");
    }

    // Use a transaction for atomicity
    const transaction = this.db.transaction(() => {
      const now = new Date().toISOString();

      // Insert or update main metadata
      const upsertQuery = this.db!.prepare(`
        INSERT OR REPLACE INTO task_metadata (
          task_id, created_at, updated_at, parent_task, 
          original_requirements, ai_enhanced, creation_context, custom_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      upsertQuery.run(
        taskId,
        metadata.createdAt || now,
        now,
        metadata.parentTask || null,
        metadata.originalRequirements || null,
        metadata.aiEnhanced ? 1 : 0,
        metadata.creationContext || null,
        metadata.custom ? JSON.stringify(metadata.custom) : null
      );

      // Clear existing relationships
      this.db!.run("DELETE FROM task_subtasks WHERE parent_id = ?", taskId);
      this.db!.run("DELETE FROM task_dependencies WHERE task_id = ?", taskId);

      // Insert subtasks
      if (metadata.subtasks && metadata.subtasks.length > 0) {
        const insertSubtask = this.db!.prepare(`
          INSERT INTO task_subtasks (parent_id, subtask_id) VALUES (?, ?)
        `);

        for (const subtaskId of metadata.subtasks) {
          insertSubtask.run(taskId, subtaskId);
        }
      }

      // Insert dependencies
      if (metadata.dependencies) {
        const insertDep = this.db!.prepare(`
          INSERT INTO task_dependencies (task_id, dependency_id, dependency_type) VALUES (?, ?, ?)
        `);

        for (const depId of metadata.dependencies.prerequisite || []) {
          insertDep.run(taskId, depId, "prerequisite");
        }
        for (const depId of metadata.dependencies.optional || []) {
          insertDep.run(taskId, depId, "optional");
        }
        for (const depId of metadata.dependencies.related || []) {
          insertDep.run(taskId, depId, "related");
        }
      }
    });

    try {
      transaction();
      log.debug("Task metadata saved successfully", { taskId });
    } catch (error) {
      log.error("Failed to set task metadata", {
        taskId,
        error: getErrorMessage(error as any),
      });
      throw error;
    }
  }

  /**
   * Delete task metadata by ID
   */
  async deleteTaskMetadata(taskId: string): Promise<void> {
    await this.initialize();

    if (!this.db) {
      throw new Error("Database not initialized");
    }

    try {
      // Delete main record (cascades to relationships due to foreign keys)
      const deleteQuery = this.db.prepare("DELETE FROM task_metadata WHERE task_id = ?");
      deleteQuery.run(taskId);

      log.debug("Task metadata deleted successfully", { taskId });
    } catch (error) {
      log.error("Failed to delete task metadata", {
        taskId,
        error: getErrorMessage(error as any),
      });
      throw error;
    }
  }

  /**
   * Query tasks by metadata criteria
   */
  async queryTasks(query: MetadataQuery): Promise<TaskMetadata[]> {
    await this.initialize();

    if (!this.db) {
      throw new Error("Database not initialized");
    }

    try {
      let sql = "SELECT task_id FROM task_metadata WHERE 1=1";
      const params: any[] = [];

      // Add query conditions
      if (query.taskIds && query.taskIds.length > 0) {
        const placeholders = query.taskIds.map(() => "?").join(",");
        sql += ` AND task_id IN (${placeholders})`;
        params.push(...query.taskIds);
      }

      if (query.hasParent !== undefined) {
        if (query.hasParent) {
          sql += " AND parent_task IS NOT NULL";
        } else {
          sql += " AND parent_task IS NULL";
        }
      }

      if (query.parentTask) {
        sql += " AND parent_task = ?";
        params.push(query.parentTask);
      }

      if (query.aiEnhanced !== undefined) {
        sql += " AND ai_enhanced = ?";
        params.push(query.aiEnhanced ? 1 : 0);
      }

      if (query.creationContext) {
        sql += " AND creation_context = ?";
        params.push(query.creationContext);
      }

      // Add sorting
      if (query.sortBy) {
        const column =
          query.sortBy === "createdAt"
            ? "created_at"
            : query.sortBy === "updatedAt"
              ? "updated_at"
              : "task_id";
        const order = query.sortOrder === "desc" ? "DESC" : "ASC";
        sql += ` ORDER BY ${column} ${order}`;
      }

      // Add pagination
      if (query.limit) {
        sql += " LIMIT ?";
        params.push(query.limit);

        if (query.offset) {
          sql += " OFFSET ?";
          params.push(query.offset);
        }
      }

      const taskIds = this.db.prepare(sql).all(...params) as any[];

      // Get full metadata for each task
      const results: TaskMetadata[] = [];
      for (const row of taskIds) {
        const metadata = await this.getTaskMetadata(row.task_id);
        if (metadata) {
          results.push(metadata);
        }
      }

      return results;
    } catch (error) {
      log.error("Failed to query tasks by metadata", {
        query,
        error: getErrorMessage(error as any),
      });
      throw error;
    }
  }

  /**
   * Get subtasks for a parent task
   */
  async getSubtasks(parentId: string): Promise<TaskMetadata[]> {
    await this.initialize();

    if (!this.db) {
      throw new Error("Database not initialized");
    }

    try {
      const query = this.db.prepare(`
        SELECT subtask_id FROM task_subtasks WHERE parent_id = ?
      `);
      const subtaskIds = query.all(parentId) as any[];

      const results: TaskMetadata[] = [];
      for (const row of subtaskIds) {
        const metadata = await this.getTaskMetadata(row.subtask_id);
        if (metadata) {
          results.push(metadata);
        }
      }

      return results;
    } catch (error) {
      log.error("Failed to get subtasks", {
        parentId,
        error: getErrorMessage(error as any),
      });
      throw error;
    }
  }

  /**
   * Get dependencies for a task
   */
  async getDependencies(taskId: string): Promise<TaskMetadata[]> {
    await this.initialize();

    if (!this.db) {
      throw new Error("Database not initialized");
    }

    try {
      const query = this.db.prepare(`
        SELECT dependency_id FROM task_dependencies WHERE task_id = ?
      `);
      const depIds = query.all(taskId) as any[];

      const results: TaskMetadata[] = [];
      for (const row of depIds) {
        const metadata = await this.getTaskMetadata(row.dependency_id);
        if (metadata) {
          results.push(metadata);
        }
      }

      return results;
    } catch (error) {
      log.error("Failed to get dependencies", {
        taskId,
        error: getErrorMessage(error as any),
      });
      throw error;
    }
  }

  /**
   * Set metadata for multiple tasks atomically
   */
  async setMultipleTaskMetadata(metadata: Record<string, TaskMetadata>): Promise<void> {
    await this.initialize();

    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const transaction = this.db.transaction(() => {
      for (const [taskId, meta] of Object.entries(metadata)) {
        // Use the internal transaction-safe version
        this.setTaskMetadata(taskId, meta);
      }
    });

    try {
      transaction();
      log.debug("Multiple task metadata saved successfully", {
        count: Object.keys(metadata).length,
      });
    } catch (error) {
      log.error("Failed to set multiple task metadata", {
        count: Object.keys(metadata).length,
        error: getErrorMessage(error as any),
      });
      throw error;
    }
  }

  /**
   * Delete metadata for multiple tasks atomically
   */
  async deleteMultipleTaskMetadata(taskIds: string[]): Promise<void> {
    await this.initialize();

    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const transaction = this.db.transaction(() => {
      const deleteQuery = this.db!.prepare("DELETE FROM task_metadata WHERE task_id = ?");
      for (const taskId of taskIds) {
        deleteQuery.run(taskId);
      }
    });

    try {
      transaction();
      log.debug("Multiple task metadata deleted successfully", {
        count: taskIds.length,
      });
    } catch (error) {
      log.error("Failed to delete multiple task metadata", {
        count: taskIds.length,
        error: getErrorMessage(error as any),
      });
      throw error;
    }
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
      log.debug("SQLite metadata database closed");
    }
  }

  /**
   * Create a backup of the database
   */
  async backup(backupPath: string): Promise<void> {
    await this.initialize();

    if (!this.db) {
      throw new Error("Database not initialized");
    }

    try {
      // Remove existing backup file if it exists
      const fs = await import("fs/promises");
      try {
        await fs.unlink(backupPath);
      } catch (e) {
        // Ignore if file doesn't exist
      }

      // Use SQLite backup API
      this.db.run(`VACUUM INTO '${backupPath}'`);

      log.debug("Database backup created successfully", {
        source: this.databasePath,
        backup: backupPath,
      });
    } catch (error) {
      log.error("Failed to create database backup", {
        source: this.databasePath,
        backup: backupPath,
        error: getErrorMessage(error as any),
      });
      throw error;
    }
  }

  /**
   * Restore database from backup
   */
  async restore(backupPath: string): Promise<void> {
    try {
      if (this.db) {
        await this.close();
      }

      // Replace current database with backup
      const fs = await import("fs/promises");
      await fs.copyFile(backupPath, this.databasePath);

      // Reinitialize
      this.initialized = false;
      await this.initialize();

      log.debug("Database restored successfully", {
        backup: backupPath,
        target: this.databasePath,
      });
    } catch (error) {
      log.error("Failed to restore database from backup", {
        backup: backupPath,
        target: this.databasePath,
        error: getErrorMessage(error as any),
      });
      throw error;
    }
  }
}

/**
 * Create a new SQLite metadata database instance
 */
export function createSqliteMetadataDatabase(
  options?: SqliteMetadataDatabaseOptions
): MetadataDatabase {
  return new SqliteMetadataDatabase(options);
}

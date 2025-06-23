/**
 * SQLite Storage Backend using Bun's native SQLite driver
 *
 * Uses bun:sqlite which is faster and natively compatible with Bun runtime.
 * No need for better-sqlite3 dependency.
 */

import { Database } from "bun:sqlite";
import type {
  DatabaseStorage,
  DatabaseReadResult,
  DatabaseWriteResult,
  DatabaseQueryOptions,
} from "../database-storage";
import { log } from "../../../utils/logger";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";

export interface SqliteStorageConfig {
  dbPath: string;
  enableWAL?: boolean;
  timeout?: number;
}

/**
 * SQLite storage implementation using Bun's native driver
 */
export class SqliteStorage<TEntity extends Record<string, any>, TState>
  implements DatabaseStorage<TEntity, TState>
{
  private db: Database | null = null;
  private initialized = false;
  private readonly dbPath: string;
  private readonly config: SqliteStorageConfig;

  constructor(config: SqliteStorageConfig) {
    this.config = config;
    this.dbPath = config.dbPath;
  }

  async initialize(): Promise<boolean> {
    if (this.initialized) return true;

    try {
      // Ensure directory exists
      const dbDir = dirname(this.dbPath);
      if (!existsSync(dbDir)) {
        mkdirSync(dbDir, { recursive: true });
      }

      // Open database with Bun's native SQLite driver
      this.db = new Database(this.dbPath);

      // Enable WAL mode for better performance
      if (this.config.enableWAL !== false) {
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.db.exec("PRAGMA synchronous = NORMAL;");
      }

      // Set timeout if specified
      if (this.config.timeout) {
        this.db.exec(`PRAGMA busy_timeout = ${this.config.timeout};`);
      }

      // Additional performance optimizations
      this.db.exec("PRAGMA cache_size = 1000;");
      this.db.exec("PRAGMA temp_store = memory;");

      // Create sessions table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          session TEXT PRIMARY KEY,
          repoName TEXT NOT NULL,
          repoUrl TEXT,
          createdAt TEXT NOT NULL,
          taskId TEXT,
          branch TEXT,
          repoPath TEXT
        )
      `);

      this.initialized = true;
      log.debug("SQLite storage initialized", { dbPath: this.dbPath });
      return true;
    } catch (error) {
      log.error("Failed to initialize SQLite storage", { error, dbPath: this.dbPath });
      return false;
    }
  }

  async readState(): Promise<DatabaseReadResult<TState>> {
    if (!this.db) {
      return { success: false, error: new Error("Database not initialized") };
    }

    try {
      const sessions = this.db.prepare("SELECT * FROM sessions").all() as TEntity[];

      // Construct state object - this assumes TState has a sessions array
      // and possibly other fields like baseDir
      const state = {
        sessions,
        baseDir: process.env.XDG_STATE_HOME || `${process.env.HOME}/.local/state/minsky/git`,
      } as TState;

      return { success: true, data: state };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  async writeState(state: TState): Promise<DatabaseWriteResult> {
    if (!this.db) {
      return { success: false, error: new Error("Database not initialized") };
    }

    try {
      // Begin transaction
      const transaction = this.db.transaction((sessions: TEntity[]) => {
        // Clear existing sessions
        this.db!.exec("DELETE FROM sessions");

        // Insert new sessions
        const insertStmt = this.db!.prepare(`
          INSERT INTO sessions (session, repoName, repoUrl, createdAt, taskId, branch, repoPath)
          VALUES ($session, $repoName, $repoUrl, $createdAt, $taskId, $branch, $repoPath)
        `);

        for (const session of sessions) {
          insertStmt.run({
            $session: session.session,
            $repoName: session.repoName,
            $repoUrl: session.repoUrl || null,
            $createdAt: session.createdAt,
            $taskId: session.taskId || null,
            $branch: session.branch || null,
            $repoPath: session.repoPath || null,
          });
        }
      });

      // Execute transaction
      const sessions = (state as any).sessions || [];
      transaction(sessions);

      return { success: true, bytesWritten: sessions.length };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  async getEntity(id: string, options?: DatabaseQueryOptions): Promise<TEntity | null> {
    if (!this.db) {
      return null;
    }

    try {
      const selectStmt = this.db.prepare("SELECT * FROM sessions WHERE session = $session");
      const result = selectStmt.get({ $session: id }) as TEntity | undefined;

      return result || null;
    } catch (error) {
      log.error("Failed to get entity from SQLite", { error, id });
      return null;
    }
  }

  async getEntities(options?: DatabaseQueryOptions): Promise<TEntity[]> {
    if (!this.db) {
      return [];
    }

    try {
      const sessions = this.db.prepare("SELECT * FROM sessions").all() as TEntity[];
      return sessions;
    } catch (error) {
      log.error("Failed to get entities from SQLite", { error });
      return [];
    }
  }

  async createEntity(entity: TEntity): Promise<TEntity> {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    try {
      const insertStmt = this.db.prepare(`
        INSERT INTO sessions (session, repoName, repoUrl, createdAt, taskId, branch, repoPath)
        VALUES ($session, $repoName, $repoUrl, $createdAt, $taskId, $branch, $repoPath)
      `);

      insertStmt.run({
        $session: entity.session,
        $repoName: entity.repoName,
        $repoUrl: entity.repoUrl || null,
        $createdAt: entity.createdAt,
        $taskId: entity.taskId || null,
        $branch: entity.branch || null,
        $repoPath: entity.repoPath || null,
      });

      return entity;
    } catch (error) {
      log.error("Failed to create entity in SQLite", { error, entity });
      throw error;
    }
  }

  async updateEntity(id: string, updates: Partial<TEntity>): Promise<TEntity | null> {
    if (!this.db) {
      return null;
    }

    try {
      // Get existing entity first
      const existing = await this.getEntity(id);
      if (!existing) {
        return null;
      }

      const updateFields = [];
      const params: Record<string, any> = { $session: id };

      for (const [key, value] of Object.entries(updates)) {
        if (key !== "session") {
          updateFields.push(`${key} = $${key}`);
          params[`$${key}`] = value;
        }
      }

      if (updateFields.length === 0) {
        return existing; // No updates needed
      }

      const updateStmt = this.db.prepare(`
        UPDATE sessions SET ${updateFields.join(", ")} WHERE session = $session
      `);

      const result = updateStmt.run(params);

      if (result.changes === 0) {
        return null;
      }

      // Return updated entity
      return { ...existing, ...updates };
    } catch (error) {
      log.error("Failed to update entity in SQLite", { error, id, updates });
      throw error;
    }
  }

  async deleteEntity(id: string): Promise<boolean> {
    if (!this.db) {
      return false;
    }

    try {
      const deleteStmt = this.db.prepare("DELETE FROM sessions WHERE session = $session");
      const result = deleteStmt.run({ $session: id });

      return result.changes > 0;
    } catch (error) {
      log.error("Failed to delete entity from SQLite", { error, id });
      return false;
    }
  }

  async entityExists(id: string): Promise<boolean> {
    if (!this.db) {
      return false;
    }

    try {
      const selectStmt = this.db.prepare("SELECT 1 FROM sessions WHERE session = $session LIMIT 1");
      const result = selectStmt.get({ $session: id });

      return result !== undefined;
    } catch (error) {
      log.error("Failed to check entity existence in SQLite", { error, id });
      return false;
    }
  }

  getStorageLocation(): string {
    return this.dbPath;
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.initialized = false;
      log.debug("SQLite storage closed");
    }
  }
}

/**
 * Create SQLite storage backend using Bun's native driver
 */
export function createSqliteStorage<TEntity extends Record<string, any>, TState>(
  config: SqliteStorageConfig
): DatabaseStorage<TEntity, TState> {
  return new SqliteStorage<TEntity, TState>(config);
}

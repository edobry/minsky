/**
 * SQLite Storage Backend for Sessions
 *
 * This module implements the DatabaseStorage interface using SQLite database
 * with Drizzle ORM for session record management.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { log } from "../../../utils/logger";
import type {
  DatabaseStorage,
  DatabaseReadResult,
  DatabaseWriteResult,
  DatabaseQueryOptions,
} from "../database-storage";
import type { SessionRecord, SessionDbState } from "../../session/session-db";
import {
  sqliteSessions,
  toSqliteInsert,
  fromSqliteSelect,
} from "../schemas/session-schema";

/**
 * SQLite storage configuration
 */
export interface SqliteStorageConfig {
  /**
   * Path to SQLite database file
   */
  dbPath: string;
  
  /**
   * Whether to enable WAL mode (default: true)
   */
  enableWAL?: boolean;
  
  /**
   * Connection timeout in milliseconds (default: 5000)
   */
  timeout?: number;
}

/**
 * SQLite storage implementation
 */
export class SqliteStorage implements DatabaseStorage<SessionRecord, SessionDbState> {
  private db: Database.Database;
  private drizzle: ReturnType<typeof drizzle>;
  private readonly dbPath: string;

  constructor(config: SqliteStorageConfig) {
    this.dbPath = config.dbPath;
    
    // Ensure directory exists
    const dbDir = dirname(this.dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    // Initialize SQLite database
    this.db = new Database(this.dbPath, {
      timeout: config.timeout || 5000,
    });

    // Configure SQLite for better performance
    this.db.pragma("journal_mode = WAL");
    if (config.enableWAL !== false) {
      this.db.pragma("synchronous = NORMAL");
    }
    this.db.pragma("cache_size = 1000");
    this.db.pragma("temp_store = memory");

    // Initialize Drizzle
    this.drizzle = drizzle(this.db);

    // Run migrations
    try {
      migrate(this.drizzle, { migrationsFolder: "./src/domain/storage/migrations" });
    } catch (error) {
      log.warn("Migration error (may be expected for new database):", error);
    }
  }

  /**
   * Initialize the storage (create tables if needed)
   */
  async initialize(): Promise<boolean> {
    try {
      // Create table if it doesn't exist
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          session TEXT PRIMARY KEY,
          repo_name TEXT NOT NULL,
          repo_url TEXT NOT NULL,
          created_at TEXT NOT NULL,
          task_id TEXT NOT NULL,
          branch TEXT NOT NULL,
          repo_path TEXT
        )
      `);

      return true;
    } catch (error) {
      log.error("Failed to initialize SQLite storage:", error);
      return false;
    }
  }

  /**
   * Read the entire database state
   */
  async readState(): Promise<DatabaseReadResult<SessionDbState>> {
    try {
      const sessions = await this.getEntities();
      const state: SessionDbState = {
        sessions,
        baseDir: dirname(this.dbPath),
      };
      
      return { success: true, data: state };
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      log.error("Failed to read SQLite state:", typedError);
      return { success: false, error: typedError };
    }
  }

  /**
   * Write the entire database state
   */
  async writeState(state: SessionDbState): Promise<DatabaseWriteResult> {
    try {
      // Begin transaction
      const transaction = this.db.transaction(() => {
        // Clear existing sessions
        this.drizzle.delete(sqliteSessions).run();
        
        // Insert all sessions
        for (const session of state.sessions) {
          const insertData = toSqliteInsert(session);
          this.drizzle.insert(sqliteSessions).values(insertData).run();
        }
      });

      transaction();
      
      return { success: true, bytesWritten: state.sessions.length };
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      log.error("Failed to write SQLite state:", typedError);
      return { success: false, error: typedError };
    }
  }

  /**
   * Get a single session by ID
   */
  async getEntity(id: string, options?: DatabaseQueryOptions): Promise<SessionRecord | null> {
    try {
      const result = this.drizzle
        .select()
        .from(sqliteSessions)
        .where(eq(sqliteSessions.session, id))
        .get();

      return result ? fromSqliteSelect(result) : null;
    } catch (error) {
      log.error("Failed to get session from SQLite:", error);
      return null;
    }
  }

  /**
   * Get all sessions that match the query options
   */
  async getEntities(options?: DatabaseQueryOptions): Promise<SessionRecord[]> {
    try {
      const results = this.drizzle.select().from(sqliteSessions).all();
      return results.map(fromSqliteSelect);
    } catch (error) {
      log.error("Failed to get sessions from SQLite:", error);
      return [];
    }
  }

  /**
   * Create a new session
   */
  async createEntity(entity: SessionRecord): Promise<SessionRecord> {
    try {
      const insertData = toSqliteInsert(entity);
      this.drizzle.insert(sqliteSessions).values(insertData).run();
      return entity;
    } catch (error) {
      log.error("Failed to create session in SQLite:", error);
      throw error;
    }
  }

  /**
   * Update an existing session
   */
  async updateEntity(id: string, updates: Partial<SessionRecord>): Promise<SessionRecord | null> {
    try {
      // Get existing session
      const existing = await this.getEntity(id);
      if (!existing) {
        return null;
      }

      // Merge updates
      const updated = { ...existing, ...updates };
      const updateData = toSqliteInsert(updated);

      // Update in database
      this.drizzle
        .update(sqliteSessions)
        .set(updateData)
        .where(eq(sqliteSessions.session, id))
        .run();

      return updated;
    } catch (error) {
      log.error("Failed to update session in SQLite:", error);
      throw error;
    }
  }

  /**
   * Delete a session by ID
   */
  async deleteEntity(id: string): Promise<boolean> {
    try {
      const result = this.drizzle
        .delete(sqliteSessions)
        .where(eq(sqliteSessions.session, id))
        .run();

      return result.changes > 0;
    } catch (error) {
      log.error("Failed to delete session from SQLite:", error);
      return false;
    }
  }

  /**
   * Check if a session exists
   */
  async entityExists(id: string): Promise<boolean> {
    try {
      const result = this.drizzle
        .select({ session: sqliteSessions.session })
        .from(sqliteSessions)
        .where(eq(sqliteSessions.session, id))
        .get();

      return result !== undefined;
    } catch (error) {
      log.error("Failed to check session existence in SQLite:", error);
      return false;
    }
  }

  /**
   * Get storage location
   */
  getStorageLocation(): string {
    return this.dbPath;
  }

  /**
   * Close the database connection
   */
  close(): void {
    try {
      this.db.close();
    } catch (error) {
      log.error("Error closing SQLite database:", error);
    }
  }
}

/**
 * Create a new SQLite storage instance
 */
export function createSqliteStorage(config: SqliteStorageConfig): DatabaseStorage<SessionRecord, SessionDbState> {
  return new SqliteStorage(config);
} 

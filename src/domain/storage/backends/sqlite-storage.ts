/**
 * SqliteStorage Backend
 * 
 * This module implements the DatabaseStorage interface for SQLite database storage
 * using Drizzle ORM.
 */

import { join } from "path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq, and } from "drizzle-orm";
import Database from "better-sqlite3";
import type { DatabaseStorage, DatabaseReadResult, DatabaseWriteResult, DatabaseQueryOptions } from "../database-storage";
import type { SessionRecord, SessionDbState } from "../../session/session-db";
import { sessionsTableSqlite } from "../schemas/session-schema";
import { log } from "../../../utils/logger";

/**
 * SQLite Storage implementation for session records
 */
export class SqliteStorage implements DatabaseStorage<SessionRecord, SessionDbState> {
  private readonly dbPath: string;
  private readonly baseDir: string;
  private db: Database.Database | null = null;
  private drizzleDb: ReturnType<typeof drizzle> | null = null;

  constructor(dbPath?: string, baseDir?: string) {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
    
    this.dbPath = dbPath || join(xdgStateHome, "minsky", "sessions.db");
    this.baseDir = baseDir || join(xdgStateHome, "minsky", "git");
  }

  private async ensureConnection(): Promise<ReturnType<typeof drizzle>> {
    if (!this.db || !this.drizzleDb) {
      this.db = new Database(this.dbPath);
      this.drizzleDb = drizzle(this.db);
      
      // Run migrations if needed
      try {
        migrate(this.drizzleDb, { migrationsFolder: "./src/domain/storage/migrations" });
      } catch (error) {
        log.warn(`Migration error (may be expected): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return this.drizzleDb;
  }

  async readState(): Promise<DatabaseReadResult<SessionDbState>> {
    try {
      const db = await this.ensureConnection();
      const sessions = await db.select().from(sessionsTableSqlite);
      
      return {
        success: true,
        data: {
          sessions,
          baseDir: this.baseDir,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error(`Error reading SQLite database: ${err.message}`);
      return {
        success: false,
        error: err,
      };
    }
  }

  async writeState(state: SessionDbState): Promise<DatabaseWriteResult> {
    try {
      const db = await this.ensureConnection();
      
      // Clear existing sessions and insert new ones
      await db.delete(sessionsTableSqlite);
      
      if (state.sessions.length > 0) {
        await db.insert(sessionsTableSqlite).values(state.sessions);
      }
      
      return {
        success: true,
        bytesWritten: state.sessions.length,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error(`Error writing SQLite database: ${err.message}`);
      return {
        success: false,
        error: err,
      };
    }
  }

  async getEntity(id: string): Promise<SessionRecord | null> {
    try {
      const db = await this.ensureConnection();
      const result = await db.select().from(sessionsTableSqlite).where(eq(sessionsTableSqlite.session, id));
      
      return result.length > 0 ? result[0] : null;
    } catch (error) {
      log.error(`Error getting entity: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async getEntities(options?: DatabaseQueryOptions): Promise<SessionRecord[]> {
    try {
      const db = await this.ensureConnection();
      let query = db.select().from(sessionsTableSqlite);
      
      // Apply filters if provided
      if (options) {
        const conditions = [];
        
        if (options.taskId) {
          const normalizedTaskId = options.taskId.replace(/^#/, "");
          conditions.push(eq(sessionsTableSqlite.taskId, normalizedTaskId));
        }
        if (options.repoName) {
          conditions.push(eq(sessionsTableSqlite.repoName, options.repoName));
        }
        if (options.branch) {
          conditions.push(eq(sessionsTableSqlite.branch, options.branch));
        }
        
        if (conditions.length > 0) {
          query = query.where(and(...conditions));
        }
      }
      
      return await query;
    } catch (error) {
      log.error(`Error getting entities: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  async createEntity(entity: SessionRecord): Promise<SessionRecord> {
    try {
      const db = await this.ensureConnection();
      await db.insert(sessionsTableSqlite).values(entity);
      return entity;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error(`Error creating entity: ${err.message}`);
      throw new Error(`Failed to create entity: ${err.message}`);
    }
  }

  async updateEntity(id: string, updates: Partial<SessionRecord>): Promise<SessionRecord | null> {
    try {
      const db = await this.ensureConnection();
      
      // Filter out the session property from updates
      const safeUpdates: Partial<Omit<SessionRecord, "session">> = {};
      Object.entries(updates).forEach(([key, value]) => {
        if (key !== "session") {
          (safeUpdates as any)[key] = value;
        }
      });
      
      const result = await db.update(sessionsTableSqlite)
        .set(safeUpdates)
        .where(eq(sessionsTableSqlite.session, id))
        .returning();
      
      return result.length > 0 ? result[0] : null;
    } catch (error) {
      log.error(`Error updating entity: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async deleteEntity(id: string): Promise<boolean> {
    try {
      const db = await this.ensureConnection();
      const result = await db.delete(sessionsTableSqlite)
        .where(eq(sessionsTableSqlite.session, id))
        .returning();
      
      return result.length > 0;
    } catch (error) {
      log.error(`Error deleting entity: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async entityExists(id: string): Promise<boolean> {
    const entity = await this.getEntity(id);
    return entity !== null;
  }

  getStorageLocation(): string {
    return this.dbPath;
  }

  async initialize(): Promise<boolean> {
    try {
      await this.ensureConnection();
      return true;
    } catch (error) {
      log.error(`Error initializing SQLite storage: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.drizzleDb = null;
    }
  }
} 

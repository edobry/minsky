/**
 * Generic SQLite Storage Backend using Drizzle ORM with Bun's native SQLite driver
 *
 * This is a truly generic implementation that can work with any entity type,
 * not just sessions. It stores data as JSON blobs with minimal schema.
 */

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { eq, sql } from "drizzle-orm";
import type {
  DatabaseStorage,
  DatabaseReadResult,
  DatabaseWriteResult,
  DatabaseQueryOptions,
} from "../database-storage";
import { log } from "../../../utils/logger";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { getErrorMessage } from "../../../errors/index";

export interface GenericSqliteStorageConfig {
  dbPath: string;
  tableName: string;
  enableWAL?: boolean;
  timeout?: number;
}

/**
 * Generic SQLite storage implementation using Drizzle ORM with Bun's native driver
 * Stores entities as JSON blobs with minimal schema requirements
 */
export class GenericSqliteStorage<TEntity extends Record<string, any>, TState>
  implements DatabaseStorage<TEntity, TState>
{
  private db: Database | null = null;
  private drizzleDb: ReturnType<typeof drizzle> | null = null;
  private table: any;
  private initialized = false;
  private readonly dbPath: string;
  private readonly config: GenericSqliteStorageConfig;

  constructor(config: GenericSqliteStorageConfig) {
    this.config = config;
    this.dbPath = config.dbPath;
    
    // Create dynamic table schema
    this.table = sqliteTable(config.tableName, {
      id: text("id").primaryKey(),
      data: text("data").notNull(),
      created_at: integer("created_at", { mode: "timestamp" }),
      updated_at: integer("updated_at", { mode: "timestamp" }),
    });
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

      // Create Drizzle instance
      this.drizzleDb = drizzle(this.db);

      // Enable WAL mode for better performance
      if (this.config.enableWAL !== false) {
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.db.exec("PRAGMA synchronous = NORMAL;");
      }

      // Set timeout if specified
      if (this.config.timeout) {
        this.db.exec(`PRAGMA busy_timeout = ${this.config.timeout};`);
      }

      // Create table if it doesn't exist
      await this.createTable();

      this.initialized = true;
      log.debug("Generic SQLite storage initialized", {
        dbPath: this.dbPath,
        tableName: this.config.tableName,
      });

      return true;
    } catch (error) {
      log.error("Failed to initialize generic SQLite storage", {
        error: getErrorMessage(error as any),
        dbPath: this.dbPath,
      });
      return false;
    }
  }

  private async createTable(): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    const createTableSql = `
      CREATE TABLE IF NOT EXISTS ${this.config.tableName} (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at INTEGER,
        updated_at INTEGER
      )
    `;

    this.db.exec(createTableSql);
  }

  async readState(): Promise<DatabaseReadResult<TState>> {
    try {
      if (!this.drizzleDb) {
        await this.initialize();
      }

      // For state, we use a special '__state__' record
      const result = await this.drizzleDb!.select().from(this.table).where(eq(this.table.id, "__state__"));
      
      if (result.length === 0) {
        return { success: true, data: undefined };
      }

      const state = JSON.parse(result[0].data) as TState;
      return { success: true, data: state };
    } catch (error) {
      log.error("Failed to read state from generic SQLite storage", {
        error: getErrorMessage(error as any),
      });
      return { success: false, error: error as Error };
    }
  }

  async writeState(state: TState): Promise<DatabaseWriteResult> {
    try {
      if (!this.drizzleDb) {
        await this.initialize();
      }

      const dataString = JSON.stringify(state);
      const now = new Date();

      // Use upsert (INSERT OR REPLACE)
      await this.drizzleDb!.insert(this.table).values({
        id: "__state__",
        data: dataString,
        created_at: now,
        updated_at: now,
      }).onConflictDoUpdate({
        target: this.table.id,
        set: {
          data: dataString,
          updated_at: now,
        },
      });

      return { 
        success: true, 
        bytesWritten: Buffer.byteLength(dataString, 'utf8')
      };
    } catch (error) {
      log.error("Failed to write state to generic SQLite storage", {
        error: getErrorMessage(error as any),
      });
      return { success: false, error: error as Error };
    }
  }

  async getEntity(id: string, options?: DatabaseQueryOptions): Promise<TEntity | null> {
    try {
      if (!this.drizzleDb) {
        await this.initialize();
      }

      const result = await this.drizzleDb!.select().from(this.table).where(eq(this.table.id, id));
      
      if (result.length === 0) {
        return null;
      }

      return JSON.parse(result[0].data) as TEntity;
    } catch (error) {
      log.error("Failed to get entity from generic SQLite storage", {
        error: getErrorMessage(error as any),
        entityId: id,
      });
      throw error;
    }
  }

  async getEntities(options?: DatabaseQueryOptions): Promise<TEntity[]> {
    try {
      if (!this.drizzleDb) {
        await this.initialize();
      }

      // Exclude the special __state__ record
      const results = await this.drizzleDb!.select().from(this.table).where(
        sql`${this.table.id} != '__state__'`
      );
      
      return results.map(row => JSON.parse(row.data) as TEntity);
    } catch (error) {
      log.error("Failed to get entities from generic SQLite storage", {
        error: getErrorMessage(error as any),
      });
      throw error;
    }
  }

  async createEntity(entity: TEntity): Promise<TEntity> {
    try {
      if (!this.drizzleDb) {
        await this.initialize();
      }

      // Entity must have an id field
      const id = (entity as any).id;
      if (!id) {
        throw new Error("Entity must have an 'id' field");
      }

      const dataString = JSON.stringify(entity);
      const now = new Date();

      await this.drizzleDb!.insert(this.table).values({
        id: id,
        data: dataString,
        created_at: now,
        updated_at: now,
      });

      return entity;
    } catch (error) {
      log.error("Failed to create entity in generic SQLite storage", {
        error: getErrorMessage(error as any),
      });
      throw error;
    }
  }

  async updateEntity(id: string, updates: Partial<TEntity>): Promise<TEntity | null> {
    try {
      if (!this.drizzleDb) {
        await this.initialize();
      }

      // Get existing entity
      const existing = await this.getEntity(id);
      if (!existing) {
        return null;
      }

      // Merge updates
      const updated = { ...existing, ...updates };
      const dataString = JSON.stringify(updated);
      const now = new Date();

      await this.drizzleDb!.update(this.table)
        .set({
          data: dataString,
          updated_at: now,
        })
        .where(eq(this.table.id, id));

      return updated;
    } catch (error) {
      log.error("Failed to update entity in generic SQLite storage", {
        error: getErrorMessage(error as any),
        entityId: id,
      });
      throw error;
    }
  }

  async deleteEntity(id: string): Promise<boolean> {
    try {
      if (!this.drizzleDb) {
        await this.initialize();
      }

      const result = await this.drizzleDb!.delete(this.table).where(eq(this.table.id, id));
      return (result as any).changes > 0;
    } catch (error) {
      log.error("Failed to delete entity from generic SQLite storage", {
        error: getErrorMessage(error as any),
        entityId: id,
      });
      throw error;
    }
  }

  async entityExists(id: string): Promise<boolean> {
    try {
      const entity = await this.getEntity(id);
      return entity !== null;
    } catch (error) {
      log.error("Failed to check entity existence in generic SQLite storage", {
        error: getErrorMessage(error as any),
        entityId: id,
      });
      throw error;
    }
  }

  getStorageLocation(): string {
    return this.dbPath;
  }
}

/**
 * Factory function to create a generic SQLite storage instance
 */
export function createGenericSqliteStorage<TEntity extends Record<string, any>, TState>(
  config: GenericSqliteStorageConfig
): GenericSqliteStorage<TEntity, TState> {
  return new GenericSqliteStorage<TEntity, TState>(config);
}
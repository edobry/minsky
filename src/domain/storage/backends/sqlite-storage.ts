/**
 * SQLite Storage Backend using Drizzle ORM with Bun's native SQLite driver
 *
 * Uses bun:sqlite with drizzle-orm for type-safe database operations.
 * Provides better schema management and query building.
 */

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { eq, and, sql } from "drizzle-orm";
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

export interface SqliteStorageConfig {
  dbPath: string;
  enableWAL?: boolean;
  timeout?: number;
}

// Drizzle schema definition
const sessionsTable = sqliteTable("sessions", {
  session: (text("session") as unknown).primaryKey(),
  repoName: (text("repoName") as unknown).notNull(),
  repoUrl: text("repoUrl"),
  createdAt: (text("createdAt") as unknown).notNull(),
  taskId: text("taskId"),
  branch: text("branch"),
  repoPath: text("repoPath"),
});

type SessionRecord = typeof sessionsTable.$inferSelect;
type NewSessionRecord = typeof sessionsTable.$inferInsert;

/**
 * SQLite storage implementation using Drizzle ORM with Bun's native driver
 */
export class SqliteStorage<TEntity extends Record<string, any>, TState>
implements DatabaseStorage<TEntity, TState>
{
  private db: Database | null = null;
  private drizzleDb: ReturnType<typeof drizzle> | null = null;
  private initialized = false;
  private readonly dbPath: string;
  private readonly config: SqliteStorageConfig;

  constructor(config: SqliteStorageConfig) {
    this.config = config;
    this.dbPath = (config as unknown).dbPath;
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
      if ((this.config as unknown).enableWAL !== false) {
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.db.exec("PRAGMA synchronous = NORMAL;");
      }

      // Set timeout if specified
      if ((this.config as unknown).timeout) {
        this.db.exec(`PRAGMA busy_timeout = ${(this.config as unknown).timeout};`);
      }

      // Additional performance optimizations
      this.db.exec("PRAGMA cache_size = 1000;");
      this.db.exec("PRAGMA temp_store = memory;");

      // Create tables using Drizzle
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
      log.debug("SQLite storage initialized with Drizzle ORM", { dbPath: this.dbPath });
      return true;
    } catch (error) {
      log.error("Failed to initialize SQLite storage", { error, dbPath: this.dbPath });
      return false;
    }
  }

  async readState(): Promise<DatabaseReadResult<TState>> {
    if (!this.drizzleDb) {
      return { success: false, error: new Error("Database not initialized") };
    }

    try {
      const sessions = await (this.drizzleDb.select() as unknown).from(sessionsTable);

      // Construct state object - this assumes TState has a sessions array
      // and possibly other fields like baseDir
      const state = {
        sessions,
        baseDir: (process.env as unknown).XDG_STATE_HOME ? `${(process.env as unknown).XDG_STATE_HOME}/minsky` : `${(process.env as unknown).HOME}/.local/state/minsky` as unknown,
      } as TState;

      return { success: true, data: state };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error as any)),
      };
    }
  }

  async writeState(state: TState): Promise<DatabaseWriteResult> {
    if (!this.drizzleDb) {
      return { success: false, error: new Error("Database not initialized") };
    }

    try {
      const sessions = (state as unknown).sessions || [];

      // Use Drizzle transaction
      await (this.drizzleDb as unknown).transaction(async (tx) => {
        // Clear existing sessions
        await tx.delete(sessionsTable);

        // Insert new sessions
        if ((sessions as unknown).length > 0) {
          const sessionRecords: NewSessionRecord[] = (sessions as unknown).map((session: TEntity) => ({
            session: (session as unknown).session,
            repoName: (session as unknown).repoName,
            repoUrl: (session as unknown).repoUrl || null,
            createdAt: (session as unknown).createdAt,
            taskId: (session as unknown).taskId || null,
            branch: (session as unknown).branch || null,
            repoPath: (session as unknown).repoPath || null,
          }));

          await (tx.insert(sessionsTable) as unknown).values(sessionRecords);
        }
      });

      return { success: true, bytesWritten: (sessions as unknown).length };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error as any)),
      };
    }
  }

  async getEntity(id: string, options?: DatabaseQueryOptions): Promise<TEntity | null> {
    if (!this.drizzleDb) {
      return null as unknown;
    }

    try {
      const result = await (this.drizzleDb
        .select()
        .from(sessionsTable)
        .where(eq(sessionsTable.session, id)) as unknown).limit(1);

      return ((result as unknown)[0] as TEntity) || null;
    } catch (error) {
      const errorMessage = getErrorMessage(error as any);
      log.error(`Failed to get session '${id}': ${errorMessage}`);
      return null as unknown;
    }
  }

  async getEntities(options?: DatabaseQueryOptions): Promise<TEntity[]> {
    if (!this.drizzleDb) {
      return [];
    }

    try {
      let query = (this.drizzleDb.select() as unknown).from(sessionsTable);

      // Apply filters if provided
      if (options) {
        const conditions: any[] = [];

        if ((options as unknown).taskId) {
          // Normalize taskId by removing # prefix if present
          const normalizedTaskId = (options.taskId as unknown).replace(/^#/, "");
          // BUGFIX: Use SQL to handle null values properly
          // This finds sessions where taskId (without #) equals normalizedTaskId
          // and excludes sessions with null taskId
          conditions.push(
            sql`TRIM(${(sessionsTable as unknown).taskId}, '#') = ${normalizedTaskId} AND ${(sessionsTable as unknown).taskId} IS NOT NULL`
          );
        }

        if ((options as unknown).repoName) {
          conditions.push(eq((sessionsTable as unknown).repoName, (options as unknown).repoName));
        }

        if ((options as unknown).branch) {
          conditions.push(eq((sessionsTable as unknown).branch, (options as unknown).branch));
        }

        // Apply WHERE conditions if any exist
        if ((conditions as unknown).length > 0) {
          query = (query as unknown).where(and(...conditions)) as unknown;
        }
      }

      const sessions = await query;
      return sessions as TEntity[];
    } catch (error) {
      const errorMessage = getErrorMessage(error as any);
      log.error(`Failed to get sessions: ${errorMessage}`);
      return [];
    }
  }

  async createEntity(entity: TEntity): Promise<TEntity> {
    if (!this.drizzleDb) {
      throw new Error("Database not initialized");
    }

    try {
      const sessionRecord: NewSessionRecord = {
        session: (entity as unknown).session,
        repoName: (entity as unknown).repoName,
        repoUrl: (entity as unknown).repoUrl || null,
        createdAt: (entity as unknown).createdAt,
        taskId: (entity as unknown).taskId || null,
        branch: (entity as unknown).branch || null,
        repoPath: (entity as unknown).repoPath || null,
      };

      await (this.drizzleDb.insert(sessionsTable) as unknown).values(sessionRecord);
      return entity;
    } catch (error) {
      const errorMessage = getErrorMessage(error as any);
      log.debug(`Failed to create session '${(entity as unknown).session}': ${errorMessage}`);
      throw error;
    }
  }

  async updateEntity(id: string, updates: Partial<TEntity>): Promise<TEntity | null> {
    if (!this.drizzleDb) {
      return null as unknown;
    }

    try {
      // Get existing entity first
      const existing = await this.getEntity(id);
      if (!existing) {
        return null as unknown;
      }

      // Prepare update data
      const updateData: Partial<NewSessionRecord> = {};
      if ((updates as unknown).repoName !== undefined) (updateData as unknown).repoName = (updates as unknown).repoName;
      if ((updates as unknown).repoUrl !== undefined) (updateData as unknown).repoUrl = (updates as unknown).repoUrl;
      if ((updates as unknown).createdAt !== undefined) (updateData as unknown).createdAt = (updates as unknown).createdAt;
      if ((updates as unknown).taskId !== undefined) (updateData as unknown).taskId = (updates as unknown).taskId;
      if ((updates as unknown).branch !== undefined) (updateData as unknown).branch = (updates as unknown).branch;
      if ((updates as unknown).repoPath !== undefined) (updateData as unknown).repoPath = (updates as unknown).repoPath;

      if ((Object.keys(updateData) as unknown).length === 0) {
        return existing; // No updates needed
      }

      await (this.drizzleDb
        .update(sessionsTable)
        .set(updateData as unknown) as unknown).where(eq((sessionsTable as unknown).session, id));

      // Return updated entity
      return { ...existing, ...updates };
    } catch (error) {
      log.error("Failed to update entity in SQLite", { error, id, updates });
      throw error;
    }
  }

  async deleteEntity(id: string): Promise<boolean> {
    if (!this.drizzleDb) {
      return false;
    }

    try {
      await (this.drizzleDb.delete(sessionsTable) as unknown).where(eq((sessionsTable as unknown).session, id));

      // Since Drizzle doesn't return changes count, we'll check if the entity existed
      const entityExists = await this.entityExists(id);
      return !entityExists; // If it doesn't exist after delete, deletion was successful
    } catch (error) {
      log.error("Failed to delete entity from SQLite", { error, id });
      return false;
    }
  }

  async entityExists(id: string): Promise<boolean> {
    if (!this.drizzleDb) {
      return false;
    }

    try {
      const result = await (this.drizzleDb
        .select({ count: sessionsTable.session })
        .from(sessionsTable)
        .where(eq(sessionsTable.session, id)) as unknown).limit(1);

      return (result as unknown).length > 0 as unknown;
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
      this.drizzleDb = null;
      this.initialized = false;
      log.debug("SQLite storage closed");
    }
  }
}

/**
 * Create SQLite storage backend using Drizzle ORM with Bun's native driver
 */
export function createSqliteStorage<TEntity extends Record<string, any>, TState>(
  config: SqliteStorageConfig
): DatabaseStorage<TEntity, TState> {
  return new SqliteStorage<TEntity, TState>(config as unknown);
}

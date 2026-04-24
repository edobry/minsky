/**
 * SQLite Storage Backend using Drizzle ORM with Bun's native SQLite driver
 *
 * Uses bun:sqlite with drizzle-orm for type-safe database operations.
 * Provides better schema management and query building.
 */

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq, and, asc, desc, gte, lte, sql, type SQL } from "drizzle-orm";
import type {
  DatabaseStorage,
  DatabaseReadResult,
  DatabaseWriteResult,
  DatabaseQueryOptions,
} from "../database-storage";
import type {
  SessionRecord as DomainSessionRecord,
  SessionDbState,
} from "../../session/session-db";
import { sqliteSessions, toSqliteInsert } from "../schemas/session-schema";
import { log } from "../../../utils/logger";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { getErrorMessage } from "../../../errors/index";

export interface SqliteStorageConfig {
  dbPath: string;
  enableWAL?: boolean;
  timeout?: number;
}

// Use the standard schema definition from session-schema.ts
const sessionsTable = sqliteSessions;

/**
 * Map a logical domain field name to the corresponding SQLite column.
 * Accepts both camelCase domain field names and snake_case column names.
 */
function pickSqliteOrderColumn(field: string) {
  switch (field) {
    case "lastActivityAt":
    case "last_activity_at":
      return sessionsTable.lastActivityAt;
    case "createdAt":
      return sessionsTable.createdAt;
    case "session":
      return sessionsTable.session;
    case "taskId":
      return sessionsTable.taskId;
    default:
      throw new Error(`Unsupported orderBy field for SQLite: ${field}`);
  }
}

/**
 * SQLite storage implementation using Drizzle ORM with Bun's native driver
 */
export class SqliteStorage implements DatabaseStorage<DomainSessionRecord, SessionDbState> {
  private db: Database | null = null;
  private drizzleDb: ReturnType<typeof drizzle> | null = null;
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
          repoPath TEXT
        )
      `);

      // Add missing columns if they don't exist (migration)
      try {
        this.db.exec("ALTER TABLE sessions ADD COLUMN prBranch TEXT");
      } catch (e) {
        // Column already exists
      }
      try {
        this.db.exec("ALTER TABLE sessions ADD COLUMN prApproved TEXT");
      } catch (e) {
        // Column already exists
      }
      try {
        this.db.exec("ALTER TABLE sessions ADD COLUMN prState TEXT");
      } catch (e) {
        // Column already exists
      }
      try {
        this.db.exec("ALTER TABLE sessions ADD COLUMN backendType TEXT");
      } catch (e) {
        // Column already exists
      }
      try {
        this.db.exec("ALTER TABLE sessions ADD COLUMN pullRequest TEXT");
      } catch (e) {
        // Column already exists
      }
      try {
        this.db.exec("ALTER TABLE sessions ADD COLUMN last_activity_at TEXT");
      } catch (e) {
        // Column already exists
      }
      try {
        this.db.exec("ALTER TABLE sessions ADD COLUMN last_commit_hash TEXT");
      } catch (e) {
        // Column already exists
      }
      try {
        this.db.exec("ALTER TABLE sessions ADD COLUMN last_commit_message TEXT");
      } catch (e) {
        // Column already exists
      }
      try {
        this.db.exec("ALTER TABLE sessions ADD COLUMN commit_count INTEGER");
      } catch (e) {
        // Column already exists
      }
      try {
        this.db.exec("ALTER TABLE sessions ADD COLUMN status TEXT");
      } catch (e) {
        // Column already exists
      }
      try {
        this.db.exec("ALTER TABLE sessions ADD COLUMN agent_id TEXT");
      } catch (e) {
        // Column already exists
      }

      this.initialized = true;
      log.debug("SQLite storage initialized with Drizzle ORM", { dbPath: this.dbPath });
      return true;
    } catch (error) {
      log.error("Failed to initialize SQLite storage", { error, dbPath: this.dbPath });
      return false;
    }
  }

  async readState(): Promise<DatabaseReadResult<SessionDbState>> {
    if (!this.drizzleDb) {
      return { success: false, error: new Error("Database not initialized") };
    }

    try {
      const sessions = await this.drizzleDb.select().from(sessionsTable);

      const state: SessionDbState = {
        sessions: sessions as DomainSessionRecord[],
        baseDir: process.env.XDG_STATE_HOME
          ? `${process.env.XDG_STATE_HOME}/minsky`
          : `${process.env.HOME}/.local/state/minsky`,
      };

      return { success: true, data: state };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  async writeState(state: SessionDbState): Promise<DatabaseWriteResult> {
    if (!this.drizzleDb) {
      return { success: false, error: new Error("Database not initialized") };
    }

    try {
      const sessions = state.sessions ?? [];

      // Use Drizzle transaction
      await this.drizzleDb.transaction(async (tx) => {
        // Clear existing sessions
        await tx.delete(sessionsTable);

        // Insert new sessions
        if (sessions.length > 0) {
          const sessionRecords = sessions.map((session) => toSqliteInsert(session));
          await tx.insert(sessionsTable).values(sessionRecords);
        }
      });

      return { success: true, bytesWritten: sessions.length };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  async getEntity(
    id: string,
    _options?: DatabaseQueryOptions
  ): Promise<DomainSessionRecord | null> {
    if (!this.drizzleDb) {
      return null;
    }

    try {
      const result = await this.drizzleDb
        .select()
        .from(sessionsTable)
        .where(eq(sessionsTable.session, id))
        .limit(1);

      return (result[0] as DomainSessionRecord) || null;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      log.error(`Failed to get session '${id}': ${errorMessage}`);
      return null;
    }
  }

  async getEntities(options?: DatabaseQueryOptions): Promise<DomainSessionRecord[]> {
    if (!this.drizzleDb) {
      return [];
    }

    try {
      // Build WHERE conditions from filters
      const conditions: SQL[] = [];
      if (options) {
        if (options.taskId) {
          // Normalize taskId by removing # prefix if present
          const validatedTaskId = options.taskId.replace(/^[a-z]+#/i, "").replace(/^#/, "");
          // BUGFIX: Use SQL to handle null values properly
          // This finds sessions where taskId (without #) equals validatedTaskId
          // and excludes sessions with null taskId
          conditions.push(
            sql`TRIM(${sessionsTable.taskId}, '#') = ${validatedTaskId} AND ${sessionsTable.taskId} IS NOT NULL`
          );
        }

        if (options.repoName) {
          conditions.push(eq(sessionsTable.repoName, options.repoName));
        }

        if (options.createdAfter) {
          conditions.push(gte(sessionsTable.createdAt, options.createdAfter));
        }
        if (options.createdBefore) {
          conditions.push(lte(sessionsTable.createdAt, options.createdBefore));
        }
      }

      const orderBy = (options?.orderBy ?? []).map((spec) => {
        const column = pickSqliteOrderColumn(spec.field);
        return spec.direction === "desc" ? desc(column) : asc(column);
      });

      let query = this.drizzleDb.select().from(sessionsTable).$dynamic();
      if (conditions.length > 0) {
        query = query.where(and(...conditions));
      }
      if (orderBy.length > 0) {
        query = query.orderBy(...orderBy);
      }
      if (typeof options?.limit === "number") {
        query = query.limit(options.limit);
      }
      if (typeof options?.offset === "number" && options.offset > 0) {
        query = query.offset(options.offset);
      }

      const sessions = await query;
      return sessions as DomainSessionRecord[];
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      log.error(`Failed to get sessions: ${errorMessage}`);
      return [];
    }
  }

  async createEntity(entity: DomainSessionRecord): Promise<DomainSessionRecord> {
    if (!this.drizzleDb) {
      throw new Error("Database not initialized");
    }

    try {
      const sessionRecord = toSqliteInsert(entity);
      await this.drizzleDb.insert(sessionsTable).values(sessionRecord);
      return entity;
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      log.debug(`Failed to create session '${entity.session}': ${errorMessage}`);
      throw error;
    }
  }

  async updateEntity(
    id: string,
    updates: Partial<DomainSessionRecord>
  ): Promise<DomainSessionRecord | null> {
    if (!this.drizzleDb) {
      return null;
    }

    try {
      // Get existing entity first
      const existing = await this.getEntity(id);
      if (!existing) {
        return null;
      }

      // Prepare update data using schema conversion
      const mergedEntity = { ...existing, ...updates };
      const updateData = toSqliteInsert(mergedEntity);

      // Remove the session field from updates (it's the primary key)
      delete (updateData as Partial<typeof updateData>).session;

      if (Object.keys(updateData).length === 0) {
        return existing; // No updates needed
      }

      await this.drizzleDb
        .update(sessionsTable)
        .set(updateData)
        .where(eq(sessionsTable.session, id));

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
      await this.drizzleDb.delete(sessionsTable).where(eq(sessionsTable.session, id));

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
      const result = await this.drizzleDb
        .select({ count: sessionsTable.session })
        .from(sessionsTable)
        .where(eq(sessionsTable.session, id))
        .limit(1);

      return result.length > 0;
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
export function createSqliteStorage(
  config: SqliteStorageConfig
): DatabaseStorage<DomainSessionRecord, SessionDbState> {
  return new SqliteStorage(config);
}

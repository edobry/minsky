/**
 * PostgreSQL Storage Backend for Sessions
 *
 * This module implements the DatabaseStorage interface using PostgreSQL database
 * with Drizzle ORM for session record management.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { log } from "../../../utils/logger";
import type {
  DatabaseStorage,
  DatabaseReadResult,
  DatabaseWriteResult,
  DatabaseQueryOptions,
} from "../database-storage";
import type { SessionRecord, SessionDbState } from "../../session/session-db";
import { postgresSessions, toPostgresInsert, fromPostgresSelect } from "../schemas/session-schema";

/**
 * PostgreSQL storage configuration
 */
export interface PostgresStorageConfig {
  /**
   * PostgreSQL connection string
   */
  connectionString: string;

  /**
   * Maximum number of connections in pool (default: 10)
   */
  maxConnections?: number;

  /**
   * Connection timeout in seconds (default: 30)
   */
  connectTimeout?: number;

  /**
   * Idle timeout in seconds (default: 600)
   */
  idleTimeout?: number;
}

/**
 * PostgreSQL storage implementation
 */
export class PostgresStorage implements DatabaseStorage<SessionRecord, SessionDbState> {
  private sql: ReturnType<typeof postgres>;
  private drizzle: ReturnType<typeof drizzle>;
  private readonly connectionString: string;

  constructor(config: PostgresStorageConfig) {
    this.connectionString = config.connectionString;

    // Initialize PostgreSQL connection
    this.sql = postgres(this.connectionString, {
      max: config.maxConnections || 10,
      connect_timeout: config.connectTimeout || 30,
      idle_timeout: config.idleTimeout || 600,
      // Enable connection pooling
      prepare: false,
      // Suppress NOTICE-level messages (e.g., "already exists, skipping")
      onnotice: () => {},
    });

    // Initialize Drizzle
    this.drizzle = drizzle(this.sql);

    // Do not auto-run migrations here; will be handled by dedicated task/setup
  }

  /**
   * Run database migrations
   */
  private async runMigrations(): Promise<void> {
    try {
      await migrate(this.drizzle, { migrationsFolder: "./src/domain/storage/migrations" });
    } catch (error) {
      // Log but don't throw - migrations may not exist yet
      log.debug("Migration attempt failed:", error);
    }
  }

  /**
   * Initialize the storage (create tables if needed)
   */
  async initialize(): Promise<boolean> {
    try {
      // Create table if it doesn't exist with basic schema
      await this.sql`
        CREATE TABLE IF NOT EXISTS sessions (
          session VARCHAR(255) PRIMARY KEY,
          repo_name VARCHAR(255) NOT NULL,
          repo_url VARCHAR(1000) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL,
          task_id VARCHAR(100),
          branch VARCHAR(255),
          repo_path VARCHAR(1000)
        )
      `;

      // Add missing columns if they don't exist (migration)
      const columnsToAdd = [
        { name: "pr_branch", type: "VARCHAR(255)" },
        { name: "pr_approved", type: "VARCHAR(10)" },
        { name: "pr_state", type: "TEXT" },
        { name: "backend_type", type: "VARCHAR(50)" },
        { name: "pull_request", type: "TEXT" },
      ];

      for (const column of columnsToAdd) {
        try {
          await this
            .sql`ALTER TABLE sessions ADD COLUMN ${this.sql(column.name)} ${this.sql.unsafe(column.type)}`;
          log.debug(`Added column ${column.name} to sessions table`);
        } catch (error: any) {
          // Column likely already exists - this is expected
          if (!error.message.includes("already exists")) {
            log.debug(`Failed to add column ${column.name}:`, error.message);
          }
        }
      }

      return true;
    } catch (error) {
      log.error("Failed to initialize PostgreSQL storage:", error);
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
        baseDir: "/tmp/postgres-sessions", // PostgreSQL doesn't have a filesystem base
      };

      return { success: true, data: state };
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error as any));
      // Keep user output concise; details available in debug logs
      log.warn(`Failed to read PostgreSQL state: ${typedError.message}`);
      return { success: false, error: typedError };
    }
  }

  /**
   * Write the entire database state
   */
  async writeState(state: SessionDbState): Promise<DatabaseWriteResult> {
    try {
      const sessions = state.sessions || [];

      await this.drizzle.transaction(async (tx) => {
        // Clear existing sessions
        await tx.delete(postgresSessions);

        // Insert new sessions using Drizzle schema mapping
        if (sessions.length > 0) {
          const BATCH_SIZE = 250;
          for (let i = 0; i < sessions.length; i += BATCH_SIZE) {
            const slice = sessions.slice(i, i + BATCH_SIZE);
            const values = slice.map((s) => toPostgresInsert(s));
            await tx.insert(postgresSessions).values(values);
          }
        }
      });

      return { success: true, bytesWritten: state.sessions.length };
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error as any));
      // Keep user output concise; details available in debug logs
      log.warn(`Failed to write PostgreSQL state: ${typedError.message}`);
      return { success: false, error: typedError };
    }
  }

  /**
   * Get a single session by ID
   */
  async getEntity(id: string, _options?: DatabaseQueryOptions): Promise<SessionRecord | null> {
    try {
      const result = (await this.drizzle
        .select()
        .from(postgresSessions)
        .where(eq(postgresSessions.session, id))
        .limit(1)) as any;

      return result.length > 0 ? fromPostgresSelect(result[0]) : null;
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error as any));
      log.warn(`Failed to get session from PostgreSQL: ${typedError.message}`);
      return null;
    }
  }

  /**
   * Get all sessions that match the query options
   */
  async getEntities(_options?: DatabaseQueryOptions): Promise<SessionRecord[]> {
    try {
      const results = (await this.drizzle.select().from(postgresSessions)) as any;
      return results.map(fromPostgresSelect);
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error as any));
      log.warn(`Failed to get sessions from PostgreSQL: ${typedError.message}`);
      return [];
    }
  }

  /**
   * Create a new session
   */
  async createEntity(entity: SessionRecord): Promise<SessionRecord> {
    try {
      const insertData = toPostgresInsert(entity);
      await this.drizzle.insert(postgresSessions).values(insertData);
      return entity;
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error as any));
      log.warn(`Failed to create session in PostgreSQL: ${typedError.message}`);
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
      const insertData = toPostgresInsert(updated);
      await this.drizzle
        .update(postgresSessions)
        .set(insertData)
        .where(eq(postgresSessions.session, id));
      return updated;
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error as any));
      log.warn(`Failed to update session in PostgreSQL: ${typedError.message}`);
      throw error;
    }
  }

  /**
   * Delete a session by ID
   */
  async deleteEntity(id: string): Promise<boolean> {
    try {
      await this.drizzle.delete(postgresSessions).where(eq(postgresSessions.session, id));
      return true;
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error as any));
      log.warn(`Failed to delete session in PostgreSQL: ${typedError.message}`);
      return false;
    }
  }

  /**
   * Check if a session exists
   */
  async entityExists(id: string): Promise<boolean> {
    try {
      const result = (await this.drizzle
        .select({ session: postgresSessions.session })
        .from(postgresSessions)
        .where(eq(postgresSessions.session, id))
        .limit(1)) as any;

      return result.length > 0;
    } catch (error) {
      log.error("Failed to check session existence in PostgreSQL:", error);
      return false;
    }
  }

  /**
   * Get storage location
   */
  getStorageLocation(): string {
    // Return masked connection URL for security
    const url = new URL(this.connectionString);
    return `postgresql://${url.host}${url.pathname}`;
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    try {
      await this.sql.end();
    } catch (error) {
      log.error("Error closing PostgreSQL connection:", error);
    }
  }
}

/**
 * Create a new PostgreSQL storage instance
 */
export function createPostgresStorage(
  config: PostgresStorageConfig
): DatabaseStorage<SessionRecord, SessionDbState> {
  return new PostgresStorage(config);
}

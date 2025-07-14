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
import {
  postgresSessions,
  toPostgresInsert,
  fromPostgresSelect,
} from "../schemas/session-schema";

/**
 * PostgreSQL storage configuration
 */
export interface PostgresStorageConfig {
  /**
   * PostgreSQL connection URL
   */
  connectionUrl: string;
  
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
  private readonly connectionUrl: string;

  constructor(config: PostgresStorageConfig) {
    this.connectionUrl = (config as unknown).connectionUrl;
    
    // Initialize PostgreSQL connection
    this.sql = postgres(this.connectionUrl, {
      max: (config as unknown).maxConnections || 10,
      connect_timeout: (config as unknown).connectTimeout || 30,
      idle_timeout: (config as unknown).idleTimeout || 600,
      // Enable connection pooling
      prepare: false,
    });

    // Initialize Drizzle
    this.drizzle = drizzle(this.sql);

    // Run migrations
    this.runMigrations().catch((error) => {
      log.warn("Migration error (may be expected for new database):", error as unknown);
    });
  }

  /**
   * Run database migrations
   */
  private async runMigrations(): Promise<void> {
    try {
      await migrate(this.drizzle, { migrationsFolder: "./src/domain/storage/migrations" });
    } catch (error) {
      // Log but don't throw - migrations may not exist yet
      log.debug("Migration attempt failed:", error as unknown);
    }
  }

  /**
   * Initialize the storage (create tables if needed)
   */
  async initialize(): Promise<boolean> {
    try {
      // Create table if it doesn't exist
      await this.sql`
        CREATE TABLE IF NOT EXISTS sessions (
          session VARCHAR(255) PRIMARY KEY,
          repo_name VARCHAR(255) NOT NULL,
          repo_url VARCHAR(1000) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL,
          task_id VARCHAR(100) NOT NULL,
          branch VARCHAR(255) NOT NULL,
          repo_path VARCHAR(1000)
        )
      `;

      return true;
    } catch (error) {
      log.error("Failed to initialize PostgreSQL storage:", error as unknown);
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
      log.error("Failed to read PostgreSQL state:", typedError);
      return { success: false, error: typedError };
    }
  }

  /**
   * Write the entire database state
   */
  async writeState(state: SessionDbState): Promise<DatabaseWriteResult> {
    try {
      // Begin transaction
      await this.sql.begin(async (sql) => {
        // Clear existing sessions
        await sql`DELETE FROM sessions`;
        
        // Insert all sessions
        for (const session of state.sessions) {
          const insertData = toPostgresInsert(session);
          await sql`
            INSERT INTO sessions (session, repo_name, repo_url, created_at, task_id, branch, repo_path)
            VALUES (${(insertData as unknown).session}, ${(insertData as unknown).repoName}, ${(insertData as unknown).repoUrl}, 
                   ${(insertData as unknown).createdAt}, ${(insertData as unknown).taskId}, ${(insertData as unknown).branch}, ${(insertData as unknown).repoPath})
          `;
        }
      });
      
      return { success: true, bytesWritten: state.sessions.length };
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error as any));
      log.error("Failed to write PostgreSQL state:", typedError);
      return { success: false, error: typedError };
    }
  }

  /**
   * Get a single session by ID
   */
  async getEntity(id: string, _options?: DatabaseQueryOptions): Promise<SessionRecord | null> {
    try {
      const result = await (this.drizzle
        .select()
        .from(postgresSessions)
        .where(eq(postgresSessions.session, id)) as unknown).limit(1);

      return result.length > 0 ? fromPostgresSelect((result as unknown)[0]) : null;
    } catch (error) {
      log.error("Failed to get session from PostgreSQL:", error as Error);
      return null;
    }
  }

  /**
   * Get all sessions that match the query options
   */
  async getEntities(options?: DatabaseQueryOptions): Promise<SessionRecord[]> {
    try {
      const results = await (this.drizzle.select() as unknown).from(postgresSessions);
      return results.map(fromPostgresSelect);
    } catch (error) {
      log.error("Failed to get sessions from PostgreSQL:", error as Error);
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
      log.error("Failed to create session in PostgreSQL:", error as Error);
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
      const updateData = toPostgresInsert(updated);

      // Update in database
      await (this.drizzle
        .update(postgresSessions)
        .set(updateData as unknown) as unknown).where(eq((postgresSessions as unknown).session, id));

      return updated;
    } catch (error) {
      log.error("Failed to update session in PostgreSQL:", error as unknown);
      throw error;
    }
  }

  /**
   * Delete a session by ID
   */
  async deleteEntity(id: string): Promise<boolean> {
    try {
      const result = await (this.drizzle
        .delete(postgresSessions) as unknown).where(eq((postgresSessions as unknown).session, id));

      return (result as unknown).rowCount !== null && (result as unknown).rowCount > 0 as unknown;
    } catch (error) {
      log.error("Failed to delete session from PostgreSQL:", error as unknown);
      return false;
    }
  }

  /**
   * Check if a session exists
   */
  async entityExists(id: string): Promise<boolean> {
    try {
      const result = await (this.drizzle
        .select({ session: postgresSessions.session })
        .from(postgresSessions)
        .where(eq(postgresSessions.session, id)) as unknown).limit(1);

      return result.length > 0 as unknown;
    } catch (error) {
      log.error("Failed to check session existence in PostgreSQL:", error as unknown);
      return false;
    }
  }

  /**
   * Get storage location
   */
  getStorageLocation(): string {
    // Return masked connection URL for security
    const url = new URL(this.connectionUrl);
    return `postgresql://${url.host}${url.pathname}`;
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    try {
      await this.sql.end();
    } catch (error) {
      log.error("Error closing PostgreSQL connection:", error as unknown);
    }
  }
}

/**
 * Create a new PostgreSQL storage instance
 */
export function createPostgresStorage(config: PostgresStorageConfig): DatabaseStorage<SessionRecord, SessionDbState> {
  return new PostgresStorage(config as unknown);
}

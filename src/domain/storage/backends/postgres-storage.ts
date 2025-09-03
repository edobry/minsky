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
import { readdirSync, statSync } from "fs";
import { join } from "path";
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
 * PostgreSQL storage implementation using PersistenceProvider
 */
export class PostgresStorage implements DatabaseStorage<SessionRecord, SessionDbState> {
  private sql: ReturnType<typeof postgres> | null = null;
  private drizzle: ReturnType<typeof drizzle> | null = null;
  private readonly connectionString: string;

  constructor(config: PostgresStorageConfig) {
    this.connectionString = config.connectionString;
  }

  /**
   * Initialize connections using PersistenceService
   */
  private async ensureConnection(): Promise<void> {
    if (this.drizzle && this.sql) {
      return; // Already initialized
    }

    // Get connection from PersistenceService
    const { PersistenceService } = await import("../../persistence/service");
    
    if (!PersistenceService.isInitialized()) {
      await PersistenceService.initialize();
    }
    
    const provider = PersistenceService.getProvider();
    
    if (!provider.capabilities.sql) {
      throw new Error("Current persistence provider does not support SQL operations");
    }
    
    // Get both drizzle and raw SQL connections from the provider
    this.drizzle = await provider.getDatabaseConnection?.();
    this.sql = await provider.getRawSqlConnection?.();
    
    if (!this.drizzle) {
      throw new Error("Failed to get database connection from persistence provider");
    }
    
    if (!this.sql) {
      throw new Error("Failed to get raw SQL connection from persistence provider");
    }
  }

  /**
   * Run database migrations
   */
  private async runMigrations(): Promise<void> {
    await this.ensureConnection();
    try {
      // Run SQL migrations generated for PostgreSQL dialect
      // Keep this path aligned with drizzle.pg.config.ts `out` setting
      await migrate(this.drizzle!, { migrationsFolder: "./src/domain/storage/migrations/pg" });
    } catch (error) {
      // Log but don't throw - migrations may not exist yet
      log.debug("Migration attempt failed:", error);
    }
  }

  /**
   * Determine if there are pending migrations by comparing the number of
   * migration files in the migrations folder with the number of applied
   * migrations in the __drizzle_migrations meta table.
   */
  private async hasPendingMigrations(): Promise<{
    pending: boolean;
    appliedCount: number;
    fileCount: number;
  }> {
    await this.ensureConnection();
    
    // Count migration files in folder
    const migrationsFolder = "./src/domain/storage/migrations/pg";
    let fileCount = 0;
    try {
      const entries = readdirSync(migrationsFolder);
      fileCount = entries.filter((name) => name.endsWith(".sql")).length;
    } catch (e) {
      // If folder not present, assume no migrations to apply
      fileCount = 0;
    }

    // Check if meta table exists in the drizzle schema (Drizzle default)
    const existsRes = await this.sql!<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
      ) as exists;
    `;
    const metaExists = Boolean(existsRes?.[0]?.exists);

    if (!metaExists) {
      return { pending: fileCount > 0, appliedCount: 0, fileCount };
    }

    // Count applied migrations (qualified schema)
    const countRes = await this.sql!<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "drizzle"."__drizzle_migrations";
    `;
    const appliedCount = parseInt(countRes?.[0]?.count || "0", 10);

    return { pending: appliedCount < fileCount, appliedCount, fileCount };
  }

  /**
   * Verify DB schema is up-to-date; throw with guidance if not.
   */
  private async enforceMigrationsUpToDate(): Promise<void> {
    try {
      const { pending, appliedCount, fileCount } = await this.hasPendingMigrations();
      if (pending) {
        const masked = (() => {
          try {
            const url = new URL(this.connectionString);
            return `postgresql://${url.host}${url.pathname}`;
          } catch {
            return "postgresql://<redacted>";
          }
        })();
        const guidance = [
          "Database schema is out of date.",
          `Applied migrations: ${appliedCount} / Files: ${fileCount}`,
          `Connection: ${masked}`,
          "Run schema migrations:",
          "  minsky sessiondb migrate --dry-run",
          "  minsky sessiondb migrate",
        ].join("\n");
        throw new Error(guidance);
      }
    } catch (error) {
      // Surface concise error upstream
      const message = error instanceof Error ? error.message : String(error as any);
      throw new Error(message);
    }
  }

  /**
   * Initialize the storage (create tables if needed)
   */
  async initialize(): Promise<boolean> {
    await this.ensureConnection();
    // Do not auto-run migrations; enforce up-to-date schema and instruct user
    await this.enforceMigrationsUpToDate();
    return true;
  }

  /**
   * Read the entire database state
   */
  async readState(): Promise<DatabaseReadResult<SessionDbState>> {
    try {
      await this.ensureConnection();
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
      await this.ensureConnection();
      const sessions = state.sessions || [];

      await this.drizzle!.transaction(async (tx) => {
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
      const anyErr: any = typedError as any;

      // Prefer the underlying driver error message if available (no SQL query text)
      const causeMessage =
        anyErr?.cause?.message || anyErr?.originalError?.message || anyErr?.cause?.cause?.message;

      let concise = (causeMessage || typedError.message || String(typedError as any)) as string;

      // If the message is a Drizzle wrapper ("Failed query: ..."), strip query/params blocks
      if (/^Failed query:/i.test(concise) || concise.includes("\nparams:")) {
        // Remove everything between "Failed query:" and the next "Error:" or end
        concise = concise.replace(/Failed query:[\s\S]*?(?=(\nError:)|$)/i, "");
        // Remove params block if present
        concise = concise.replace(/\nparams:[\s\S]*$/i, "");
        // Fallback to top line of original drizzle message if we removed everything
        if (!concise.trim()) {
          const top = (typedError.message || "").split("\n").find((l) => l.trim().length > 0) || "";
          // Keep only the leading part before any SQL or params label
          concise = top.replace(/Failed query:.*/, "database operation failed");
        }
      }

      // Reduce to first line and trim
      concise = (concise.split("\n")[0] || concise).trim();

      // Do not print here to avoid duplicates; caller will present this message
      return { success: false, error: new Error(concise) };
    }
  }

  /**
   * Get a single session by ID
   */
  async getEntity(id: string, _options?: DatabaseQueryOptions): Promise<SessionRecord | null> {
    try {
      await this.ensureConnection();
      const result = (await this.drizzle!
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
      await this.ensureConnection();
      const results = (await this.drizzle!.select().from(postgresSessions)) as any;
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
      await this.ensureConnection();
      const insertData = toPostgresInsert(entity);
      await this.drizzle!.insert(postgresSessions).values(insertData);
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
      await this.ensureConnection();
      // Get existing session
      const existing = await this.getEntity(id);
      if (!existing) {
        return null;
      }

      // Merge updates
      const updated = { ...existing, ...updates };
      const insertData = toPostgresInsert(updated);
      await this.drizzle!
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
      await this.ensureConnection();
      await this.drizzle!.delete(postgresSessions).where(eq(postgresSessions.session, id));
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
      await this.ensureConnection();
      const result = (await this.drizzle!
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
    // Connection is managed by PersistenceProvider, don't close it directly
    // Reset local references
    this.sql = null;
    this.drizzle = null;
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

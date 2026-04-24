/**
 * PostgreSQL Storage Backend for Sessions
 *
 * This module implements the DatabaseStorage interface using PostgreSQL database
 * with Drizzle ORM for session record management.
 */

import { injectable } from "tsyringe";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, and, asc, desc, gte, lte, type SQL } from "drizzle-orm";
import postgres from "postgres";
import { log } from "../../../utils/logger";
import { first } from "../../../utils/array-safety";
import { readdirSync } from "fs";
import { getMinskyStateDir } from "../../../utils/paths";
import type {
  DatabaseStorage,
  DatabaseReadResult,
  DatabaseWriteResult,
  DatabaseQueryOptions,
} from "../database-storage";
import type { SessionRecord, SessionDbState } from "../../session/session-db";
import { postgresSessions, toPostgresInsert, fromPostgresSelect } from "../schemas/session-schema";
import type { PersistenceProvider } from "../../persistence/types";
import { withPgPoolRetry } from "../../persistence/postgres-retry";

/**
 * Map a logical domain field name to the corresponding Postgres column.
 * Accepts camelCase field names (as used in SessionRecord) as well as the
 * snake_case column names.
 */
function pickPostgresOrderColumn(field: string) {
  switch (field) {
    case "lastActivityAt":
    case "last_activity_at":
      return postgresSessions.lastActivityAt;
    case "createdAt":
    case "created_at":
      return postgresSessions.createdAt;
    case "session":
      return postgresSessions.session;
    case "taskId":
    case "task_id":
      return postgresSessions.taskId;
    default:
      throw new Error(`Unsupported orderBy field for Postgres: ${field}`);
  }
}

/**
 * PostgreSQL storage configuration
 */
export interface PostgresStorageConfig {
  /**
   * PostgreSQL connection string
   */
  connectionString: string;

  /**
   * Informational: actual pool size is governed by PostgresPersistenceProvider
   * (see DEFAULT_POSTGRES_MAX_CONNECTIONS in postgres-provider.ts). PostgresStorage
   * reuses the provider's postgres-js client and does not open its own sockets.
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
@injectable()
export class PostgresStorage implements DatabaseStorage<SessionRecord, SessionDbState> {
  private sql: ReturnType<typeof postgres> | null = null;
  private drizzle: ReturnType<typeof drizzle> | null = null;
  private readonly connectionString: string;
  private readonly persistenceProvider: PersistenceProvider;

  constructor(config: PostgresStorageConfig, persistenceProvider: PersistenceProvider) {
    this.connectionString = config.connectionString;
    this.persistenceProvider = persistenceProvider;
  }

  /**
   * Initialize connections using the injected PersistenceProvider
   */
  private async ensureConnection(): Promise<void> {
    if (this.drizzle && this.sql) {
      return; // Already initialized
    }

    const provider: PersistenceProvider = this.persistenceProvider;

    const capabilities = provider.getCapabilities();
    if (!capabilities.sql) {
      throw new Error("Current persistence provider does not support SQL operations");
    }

    // Get both drizzle and raw SQL connections from the provider.
    // The base PersistenceProvider returns `unknown`; we narrow here after the sql capability check.
    this.drizzle = (await provider.getDatabaseConnection?.()) as typeof this.drizzle;
    this.sql = (await provider.getRawSqlConnection?.()) as typeof this.sql;

    if (!this.drizzle) {
      throw new Error("Failed to get database connection from persistence provider");
    }

    if (!this.sql) {
      throw new Error("Failed to get raw SQL connection from persistence provider");
    }
  }

  /** Returns the drizzle connection, throwing if not yet connected. */
  private get db(): NonNullable<typeof this.drizzle> {
    if (!this.drizzle) throw new Error("Database not connected — call ensureConnection() first");
    return this.drizzle;
  }

  /** Returns the raw SQL connection, throwing if not yet connected. */
  private get rawSql(): NonNullable<typeof this.sql> {
    if (!this.sql) throw new Error("SQL not connected — call ensureConnection() first");
    return this.sql;
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

    const existsRes = await this.rawSql<{ exists: boolean }[]>`
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

    const countRes = await this.rawSql<{ count: string }[]>`
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
          "  minsky persistence migrate --dry-run",
          "  minsky persistence migrate --execute",
        ].join("\n");
        throw new Error(guidance);
      }
    } catch (error) {
      // Surface concise error upstream
      const message = error instanceof Error ? error.message : String(error);
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
      return await withPgPoolRetry(async () => {
        log.debug("PostgreSQL readState: Starting");
        await this.ensureConnection();
        log.debug("PostgreSQL readState: Connection established, calling getEntitiesInternal");
        // Call the non-retrying internal variant: readState is already wrapped
        // by withPgPoolRetry above, so routing through public getEntities would
        // nest retries and multiply backoff delays on sustained saturation.
        const sessions = await this.getEntitiesInternal();
        log.debug(`PostgreSQL readState: Got ${sessions.length} sessions from getEntitiesInternal`);

        const state: SessionDbState = {
          sessions,
          baseDir: getMinskyStateDir(), // Use proper Minsky state directory for session workspaces
        };

        return { success: true as const, data: state };
      }, "postgres-storage.readState");
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      // Keep user output concise; details available in debug logs
      log.error(`Failed to read PostgreSQL state: ${typedError.message}`);
      return { success: false, error: typedError };
    }
  }

  /**
   * Write the entire database state
   */
  async writeState(state: SessionDbState): Promise<DatabaseWriteResult> {
    try {
      return await withPgPoolRetry(async () => {
        await this.ensureConnection();
        const sessions = state.sessions || [];

        await this.db.transaction(async (tx) => {
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

        return { success: true as const, bytesWritten: sessions.length };
      }, "postgres-storage.writeState");
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      // Prefer the underlying driver error message if available (no SQL query text)
      // Access driver-specific error properties not present on the base Error type
      const errWithCause = typedError as Error & {
        cause?: { message?: string; cause?: { message?: string } };
        originalError?: { message?: string };
      };
      const causeMessage: string | undefined =
        errWithCause.cause?.message ||
        errWithCause.originalError?.message ||
        errWithCause.cause?.cause?.message;

      let concise = causeMessage || typedError.message || String(typedError);

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
   * Get a single session by ID (compatibility method for SessionDbAdapter)
   */
  async get(id: string): Promise<DatabaseReadResult<SessionRecord>> {
    try {
      const entity = await this.getEntity(id);

      if (entity) {
        return { success: true, data: entity };
      } else {
        return { success: false, error: new Error(`Session '${id}' not found`) };
      }
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      return { success: false, error: typedError };
    }
  }

  /**
   * Delete a single session by ID (compatibility method for SessionDbAdapter)
   * Storage errors propagate — only returns false for "not found".
   */
  async delete(id: string): Promise<boolean> {
    return await this.deleteEntity(id);
  }

  /**
   * Get a single session by ID
   */
  async getEntity(id: string, _options?: DatabaseQueryOptions): Promise<SessionRecord | null> {
    return withPgPoolRetry(() => this.getEntityInternal(id), "postgres-storage.getEntity");
  }

  private async getEntityInternal(id: string): Promise<SessionRecord | null> {
    await this.ensureConnection();

    const result = await this.db
      .select()
      .from(postgresSessions)
      .where(eq(postgresSessions.session, id))
      .limit(1);

    return result.length > 0 ? fromPostgresSelect(first(result, "session query")) : null;
  }

  /**
   * Get all sessions that match the query options
   */
  async getEntities(options?: DatabaseQueryOptions): Promise<SessionRecord[]> {
    return withPgPoolRetry(() => this.getEntitiesInternal(options), "postgres-storage.getEntities");
  }

  private async getEntitiesInternal(options?: DatabaseQueryOptions): Promise<SessionRecord[]> {
    await this.ensureConnection();

    const conditions: SQL[] = [];
    if (options?.taskId) {
      // Normalize qualified IDs (e.g. "mt#283" → "283") to match storage format
      const normalizedTaskId = options.taskId.replace(/^[a-z]+#/i, "").replace(/^#/, "");
      conditions.push(eq(postgresSessions.taskId, normalizedTaskId));
    }
    if (options?.repoName) {
      conditions.push(eq(postgresSessions.repoName, options.repoName));
    }
    if (options?.createdAfter) {
      conditions.push(gte(postgresSessions.createdAt, new Date(options.createdAfter)));
    }
    if (options?.createdBefore) {
      conditions.push(lte(postgresSessions.createdAt, new Date(options.createdBefore)));
    }

    const orderBy = (options?.orderBy ?? []).map((spec) => {
      // Map the logical field name onto the actual Postgres column.
      // Accept both camelCase domain field names and snake_case column names.
      const column = pickPostgresOrderColumn(spec.field);
      return spec.direction === "desc" ? desc(column) : asc(column);
    });

    let query = this.db.select().from(postgresSessions).$dynamic();
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

    const results = await query;
    log.debug(`PostgreSQL getEntities: Retrieved ${results.length} raw records`);
    const mapped = results.map((record, index: number) => {
      try {
        return fromPostgresSelect(record);
      } catch (mappingError) {
        log.error(
          `Error mapping record ${index}: ${mappingError instanceof Error ? mappingError.message : String(mappingError)}`
        );
        throw mappingError;
      }
    });
    log.debug(`PostgreSQL getEntities: Mapped to ${mapped.length} SessionRecords`);
    return mapped;
  }

  /**
   * Create a new session
   */
  async createEntity(entity: SessionRecord): Promise<SessionRecord> {
    try {
      return await withPgPoolRetry(async () => {
        await this.ensureConnection();
        const insertData = toPostgresInsert(entity);

        await this.db.insert(postgresSessions).values(insertData);
        return entity;
      }, "postgres-storage.createEntity");
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      log.warn(`Failed to create session in PostgreSQL: ${typedError.message}`);
      throw error;
    }
  }

  /**
   * Update an existing session
   */
  async updateEntity(id: string, updates: Partial<SessionRecord>): Promise<SessionRecord | null> {
    try {
      return await withPgPoolRetry(async () => {
        // getEntityInternal calls ensureConnection; avoids nested retry
        // doubling by bypassing the retrying public getEntity.
        const existing = await this.getEntityInternal(id);
        if (!existing) {
          return null;
        }

        // Merge updates
        const updated = { ...existing, ...updates };
        const insertData = toPostgresInsert(updated);

        await this.db
          .update(postgresSessions)
          .set(insertData)
          .where(eq(postgresSessions.session, id));
        return updated;
      }, "postgres-storage.updateEntity");
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      log.warn(`Failed to update session in PostgreSQL: ${typedError.message}`);
      throw error;
    }
  }

  /**
   * Delete a session by ID.
   * Returns true if a row was actually deleted, false if it didn't exist.
   * Storage errors propagate — callers decide how to handle them.
   */
  async deleteEntity(id: string): Promise<boolean> {
    return withPgPoolRetry(async () => {
      await this.ensureConnection();

      const deleted = await this.db
        .delete(postgresSessions)
        .where(eq(postgresSessions.session, id))
        .returning({ session: postgresSessions.session });
      return deleted.length > 0;
    }, "postgres-storage.deleteEntity");
  }

  /**
   * Check if a session exists
   */
  async entityExists(id: string): Promise<boolean> {
    try {
      return await withPgPoolRetry(async () => {
        await this.ensureConnection();

        const result = await this.db
          .select({ session: postgresSessions.session })
          .from(postgresSessions)
          .where(eq(postgresSessions.session, id))
          .limit(1);

        return result.length > 0;
      }, "postgres-storage.entityExists");
    } catch (error) {
      log.error(
        "Failed to check session existence in PostgreSQL:",
        error instanceof Error ? error : { error: String(error) }
      );
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

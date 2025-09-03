/**
 * Session Database Adapter
 *
 * Provides session-specific database operations using the shared database service.
 * This adapter replaces the direct connection management in PostgresStorage.
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sharedDatabaseService, type ISharedDatabaseService } from "./shared-database-service";
import { log } from "../../utils/logger";

/**
 * Session database adapter interface
 */
export interface ISessionDatabaseAdapter {
  /**
   * Get the database connection for session operations
   */
  getDatabase(): Promise<PostgresJsDatabase>;

  /**
   * Verify session schema is ready
   */
  verifySchema(): Promise<boolean>;

  /**
   * Get SQL connection for raw queries (use sparingly)
   */
  getSql(): Promise<any>;
}

/**
 * Session database adapter implementation
 */
export class SessionDatabaseAdapter implements ISessionDatabaseAdapter {
  private readonly databaseService: ISharedDatabaseService;

  constructor(databaseService?: ISharedDatabaseService) {
    this.databaseService = databaseService || sharedDatabaseService;
  }

  /**
   * Get the database connection for session operations
   */
  async getDatabase(): Promise<PostgresJsDatabase> {
    try {
      return await this.databaseService.getDatabase();
    } catch (error) {
      log.error("Failed to get database connection for sessions:", error);
      throw new Error(`Session database connection failed: ${error}`);
    }
  }

  /**
   * Verify session schema is ready
   */
  async verifySchema(): Promise<boolean> {
    try {
      const sql = await this.databaseService.getSql();

      // Check if sessions table exists
      const result = await sql`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'sessions'
        ) as exists;
      `;

      const exists = Boolean(result?.[0]?.exists);

      if (!exists) {
        log.warn("Sessions table does not exist. Run migrations to create it.");

        // Check for pending migrations
        const migrationStatus = await this.databaseService.hasPendingMigrations();
        if (migrationStatus.pending) {
          log.warn(
            `There are ${migrationStatus.fileCount - migrationStatus.appliedCount} pending migrations.`
          );
        }
      }

      return exists;
    } catch (error) {
      log.error("Failed to verify session schema:", error);
      return false;
    }
  }

  /**
   * Get SQL connection for raw queries
   * Should be used sparingly, prefer getDatabase() for type safety
   */
  async getSql(): Promise<any> {
    return await this.databaseService.getSql();
  }
}

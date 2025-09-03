/**
 * Task Database Adapter
 *
 * Provides task-specific database operations using the shared database service.
 * This adapter replaces the direct connection management in MinskyTaskBackend.
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getSharedDatabaseService, type ISharedDatabaseService } from "./shared-database-service";
import { log } from "../../utils/logger";

/**
 * Task database adapter interface
 */
export interface ITaskDatabaseAdapter {
  /**
   * Get the database connection for task operations
   */
  getDatabase(): Promise<PostgresJsDatabase>;

  /**
   * Verify task schema is ready
   */
  verifySchema(): Promise<boolean>;

  /**
   * Get SQL connection for raw queries (use sparingly)
   */
  getSql(): Promise<any>;

  /**
   * Get the next available task ID
   */
  getNextTaskId(prefix?: string): Promise<string>;
}

/**
 * Task database adapter implementation
 */
export class TaskDatabaseAdapter implements ITaskDatabaseAdapter {
  private readonly databaseService: ISharedDatabaseService;

  constructor(databaseService?: ISharedDatabaseService) {
    this.databaseService = databaseService || getSharedDatabaseService();
  }

  /**
   * Get the database connection for task operations
   */
  async getDatabase(): Promise<PostgresJsDatabase> {
    try {
      return await this.databaseService.getDatabase();
    } catch (error) {
      log.error("Failed to get database connection for tasks:", error);
      throw new Error(`Task database connection failed: ${error}`);
    }
  }

  /**
   * Verify task schema is ready
   */
  async verifySchema(): Promise<boolean> {
    try {
      const sql = await this.databaseService.getSql();

      // Check if both tasks and task_specs tables exist
      const result = await sql`
        SELECT 
          (SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'tasks'
          )) as tasks_exists,
          (SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'task_specs'
          )) as specs_exists;
      `;

      const tasksExists = Boolean(result?.[0]?.tasks_exists);
      const specsExists = Boolean(result?.[0]?.specs_exists);

      if (!tasksExists || !specsExists) {
        log.warn("Task tables do not exist. Run migrations to create them.");

        // Check for pending migrations
        const migrationStatus = await this.databaseService.hasPendingMigrations();
        if (migrationStatus.pending) {
          log.warn(
            `There are ${migrationStatus.fileCount - migrationStatus.appliedCount} pending migrations.`
          );
        }
      }

      return tasksExists && specsExists;
    } catch (error) {
      log.error("Failed to verify task schema:", error);
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

  /**
   * Get the next available task ID
   */
  async getNextTaskId(prefix: string = "mt"): Promise<string> {
    try {
      const sql = await this.databaseService.getSql();

      // Find the highest task ID for the given prefix
      const result = await sql`
        SELECT MAX(CAST(SUBSTRING(id FROM '#([0-9]+)$') AS INTEGER)) as max_id
        FROM tasks
        WHERE id LIKE ${`${prefix}#%`};
      `;

      const maxId = result?.[0]?.max_id || 0;
      return `${prefix}#${maxId + 1}`;
    } catch (error) {
      log.error("Failed to generate next task ID:", error);
      throw new Error(`Task ID generation failed: ${error}`);
    }
  }
}

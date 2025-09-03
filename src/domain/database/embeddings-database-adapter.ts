/**
 * Embeddings Database Adapter
 *
 * Provides embeddings/vector-specific database operations using the shared database service.
 * This adapter replaces the direct connection management in PostgresVectorStorage.
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sharedDatabaseService, type ISharedDatabaseService } from "./shared-database-service";
import { log } from "../../utils/logger";

/**
 * Embeddings database adapter interface
 */
export interface IEmbeddingsDatabaseAdapter {
  /**
   * Get the database connection for embeddings operations
   */
  getDatabase(): Promise<PostgresJsDatabase>;

  /**
   * Get SQL connection for vector operations
   */
  getSql(): Promise<any>;

  /**
   * Verify embeddings schema and extensions are ready
   */
  verifySchema(): Promise<boolean>;

  /**
   * Ensure vector extension is enabled
   */
  ensureVectorExtension(): Promise<void>;
}

/**
 * Embeddings database adapter implementation
 */
export class EmbeddingsDatabaseAdapter implements IEmbeddingsDatabaseAdapter {
  private readonly databaseService: ISharedDatabaseService;
  private vectorExtensionVerified = false;

  constructor(databaseService?: ISharedDatabaseService) {
    this.databaseService = databaseService || sharedDatabaseService;
  }

  /**
   * Get the database connection for embeddings operations
   */
  async getDatabase(): Promise<PostgresJsDatabase> {
    try {
      // Ensure vector extension before returning connection
      if (!this.vectorExtensionVerified) {
        await this.ensureVectorExtension();
      }

      return await this.databaseService.getDatabase();
    } catch (error) {
      log.error("Failed to get database connection for embeddings:", error);
      throw new Error(`Embeddings database connection failed: ${error}`);
    }
  }

  /**
   * Get SQL connection for vector operations
   */
  async getSql(): Promise<any> {
    try {
      // Ensure vector extension before returning connection
      if (!this.vectorExtensionVerified) {
        await this.ensureVectorExtension();
      }

      return await this.databaseService.getSql();
    } catch (error) {
      log.error("Failed to get SQL connection for embeddings:", error);
      throw new Error(`Embeddings SQL connection failed: ${error}`);
    }
  }

  /**
   * Verify embeddings schema and extensions are ready
   */
  async verifySchema(): Promise<boolean> {
    try {
      const sql = await this.databaseService.getSql();

      // Check if vector extension exists
      const extResult = await sql`
        SELECT EXISTS (
          SELECT 1 FROM pg_extension
          WHERE extname = 'vector'
        ) as exists;
      `;
      const extensionExists = Boolean(extResult?.[0]?.exists);

      if (!extensionExists) {
        log.warn("Vector extension not installed. Creating it now...");
        await this.ensureVectorExtension();
      }

      // Check if embeddings tables exist
      const tableResult = await sql`
        SELECT 
          (SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'tasks_embeddings'
          )) as tasks_embeddings_exists,
          (SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'rules_embeddings'
          )) as rules_embeddings_exists,
          (SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'tool_embeddings'
          )) as tool_embeddings_exists;
      `;

      const tasksEmbeddingsExists = Boolean(tableResult?.[0]?.tasks_embeddings_exists);
      const rulesEmbeddingsExists = Boolean(tableResult?.[0]?.rules_embeddings_exists);
      const toolEmbeddingsExists = Boolean(tableResult?.[0]?.tool_embeddings_exists);

      if (!tasksEmbeddingsExists || !rulesEmbeddingsExists || !toolEmbeddingsExists) {
        log.warn("Some embeddings tables do not exist. Run migrations to create them.");

        // Check for pending migrations
        const migrationStatus = await this.databaseService.hasPendingMigrations();
        if (migrationStatus.pending) {
          log.warn(
            `There are ${migrationStatus.fileCount - migrationStatus.appliedCount} pending migrations.`
          );
        }
      }

      return (
        extensionExists && (tasksEmbeddingsExists || rulesEmbeddingsExists || toolEmbeddingsExists)
      );
    } catch (error) {
      log.error("Failed to verify embeddings schema:", error);
      return false;
    }
  }

  /**
   * Ensure vector extension is enabled
   */
  async ensureVectorExtension(): Promise<void> {
    try {
      const sql = await this.databaseService.getSql();

      log.debug("Ensuring vector extension is enabled");
      await sql`CREATE EXTENSION IF NOT EXISTS vector`;

      this.vectorExtensionVerified = true;
      log.debug("Vector extension verified");
    } catch (error) {
      log.error("Failed to ensure vector extension:", error);
      throw new Error(`Vector extension setup failed: ${error}`);
    }
  }
}

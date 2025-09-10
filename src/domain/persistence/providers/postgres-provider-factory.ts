/**
 * PostgreSQL Provider Factory
 * 
 * Creates the appropriate PostgreSQL provider class based on runtime capabilities
 */

import postgres from "postgres";
import { log } from "../../../utils/logger";
import { PersistenceConfig } from "../types";
import { PostgresPersistenceProvider, PostgresVectorPersistenceProvider } from "./postgres-provider";

/**
 * Factory that decides which PostgreSQL provider to create based on pgvector availability
 */
export class PostgresProviderFactory {
  
  /**
   * Create the appropriate PostgreSQL provider based on runtime capabilities
   * Returns PostgresVectorPersistenceProvider if pgvector available, otherwise base PostgresPersistenceProvider
   */
  static async create(config: PersistenceConfig): Promise<PostgresPersistenceProvider | PostgresVectorPersistenceProvider> {
    if (config.backend !== "postgres" || !config.postgres) {
      throw new Error("PostgresProviderFactory requires postgres configuration");
    }

    const pgConfig = config.postgres;
    
    // Test connection and check for pgvector extension
    const testSql = postgres(pgConfig.connectionString, {
      max: 1, // Just need one connection for testing
      connect_timeout: pgConfig.connectTimeout || 10,
    });

    try {
      // Verify connection works
      await testSql`SELECT 1`;
      
      // Check for pgvector extension
      const result = await testSql`
        SELECT EXISTS (
          SELECT 1 FROM pg_extension WHERE extname = 'vector'
        ) as exists
      `;
      
      await testSql.end(); // Clean up test connection
      
      const hasVectorExtension = result[0].exists;
      
      if (hasVectorExtension) {
        log.debug("Creating PostgreSQL provider with vector support");
        return new PostgresVectorPersistenceProvider(config);
      } else {
        log.debug("Creating PostgreSQL provider without vector support (pgvector not available)");
        return new PostgresPersistenceProvider(config);
      }
      
    } catch (error) {
      await testSql.end(); // Clean up on error
      log.error("Failed to test PostgreSQL capabilities:", error);
      throw error;
    }
  }
}

/**
 * Database Connection Manager (Legacy Compatibility)
 *
 * Provides backward compatibility for code that expects the old connection-manager interface.
 * Uses original implementation for reliability.
 *
 * @deprecated Use PersistenceService directly for new code
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getConfiguration } from "../configuration";
import { log } from "../../utils/logger";

/**
 * Creates a configured PostgreSQL database connection
 * 
 * @deprecated Use getPersistenceProvider().getDatabaseConnection() instead
 */
export async function createDatabaseConnection(): Promise<PostgresJsDatabase> {
  try {
    log.warn("createDatabaseConnection is deprecated. Use PersistenceService instead.");
    
    // Use original implementation for compatibility
    const runtimeConfig = getConfiguration();
    const connectionString = runtimeConfig?.sessiondb?.postgres?.connectionString;

    if (!connectionString) {
      throw new Error(
        "PostgreSQL connection string not configured (sessiondb.postgres.connectionString)"
      );
    }

    const sql = postgres(connectionString, {
      prepare: false,
      onnotice: () => {},
    });

    return drizzle(sql);
  } catch (error) {
    log.error("Failed to create database connection:", error);
    throw error;
  }
}

/**
 * Database connection manager for dependency injection
 *
 * @deprecated Use PersistenceService for dependency injection
 */
export class DatabaseConnectionManager {
  /**
   * Get database connection instance
   *
   * @deprecated Use PersistenceService.getProvider().getDatabaseConnection() instead
   */
  async getConnection(): Promise<PostgresJsDatabase> {
    return await createDatabaseConnection();
  }
}

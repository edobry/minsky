/**
 * Database Connection Manager (Compatibility Layer)
 *
 * Provides backward compatibility for code that expects the old connection-manager interface.
 * Delegates to the new PersistenceService.
 * 
 * @deprecated Use PersistenceService directly for new code
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getPersistenceProvider } from "../persistence";
import { log } from "../../utils/logger";

/**
 * Creates a configured PostgreSQL database connection
 * 
 * @deprecated Use getPersistenceProvider().getDatabaseConnection() instead
 */
export async function createDatabaseConnection(): Promise<PostgresJsDatabase> {
  try {
    log.warn("createDatabaseConnection is deprecated. Use PersistenceService instead.");
    
    const provider = await getPersistenceProvider();
    
    if (!provider.capabilities.sql) {
      throw new Error("Current persistence backend does not support SQL");
    }
    
    const connection = await provider.getDatabaseConnection?.();
    if (!connection) {
      throw new Error("Database connection not available from persistence provider");
    }
    
    return connection;
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
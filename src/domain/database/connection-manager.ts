/**
 * Database Connection Manager (Legacy)
 *
 * This module provides backward compatibility for existing code that uses
 * the old connection manager. It now delegates to the new SharedDatabaseService.
 *
 * @deprecated Use SharedDatabaseService and domain-specific adapters instead
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getSharedDatabaseService } from "./shared-database-service";

/**
 * Creates a configured PostgreSQL database connection
 * Handles configuration loading and connection creation
 * 
 * @deprecated Use getSharedDatabaseService().getDatabase() instead
 */
export async function createDatabaseConnection(): Promise<PostgresJsDatabase> {
  try {
    return await getSharedDatabaseService().getDatabase();
  } catch (error) {
    throw new Error(`Failed to create database connection: ${error}`);
  }
}

/**
 * Database Connection Manager for centralized connection handling
 *
 * @deprecated Use SharedDatabaseService.getInstance() instead
 */
export class DatabaseConnectionManager {
  private static instance: DatabaseConnectionManager | null = null;

  private constructor() {}

  static getInstance(): DatabaseConnectionManager {
    if (!DatabaseConnectionManager.instance) {
      DatabaseConnectionManager.instance = new DatabaseConnectionManager();
    }
    return DatabaseConnectionManager.instance;
  }

  async getConnection(): Promise<PostgresJsDatabase> {
    return await getSharedDatabaseService().getDatabase();
  }

  async closeConnection(): Promise<void> {
    // Delegate to shared service
    // Note: We don't actually close the shared connection here
    // as it might be used by other components
  }
}

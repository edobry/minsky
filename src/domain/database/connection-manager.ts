/**
 * Database Connection Manager
 *
 * Handles configuration loading and database connection creation
 * for dependency injection into backends that need database access.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getConfiguration } from "../configuration";

/**
 * Creates a configured PostgreSQL database connection
 * Handles configuration loading and connection creation
 */
export async function createDatabaseConnection(): Promise<PostgresJsDatabase> {
  try {
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
    throw new Error(`Failed to create database connection: ${error}`);
  }
}

/**
 * Database Connection Manager for centralized connection handling
 */
export class DatabaseConnectionManager {
  private static instance: DatabaseConnectionManager | null = null;
  private connection: PostgresJsDatabase | null = null;

  private constructor() {}

  static getInstance(): DatabaseConnectionManager {
    if (!DatabaseConnectionManager.instance) {
      DatabaseConnectionManager.instance = new DatabaseConnectionManager();
    }
    return DatabaseConnectionManager.instance;
  }

  async getConnection(): Promise<PostgresJsDatabase> {
    if (!this.connection) {
      this.connection = await createDatabaseConnection();
    }
    return this.connection;
  }

  async closeConnection(): Promise<void> {
    if (this.connection) {
      // Note: postgres-js doesn't expose a direct close method on the drizzle instance
      // The underlying connection will be closed when the process exits
      this.connection = null;
    }
  }
}

/**
 * Storage Backend Factory
 * 
 * Creates appropriate storage backend instances based on configuration.
 * Supports JSON file, SQLite, and PostgreSQL storage backends.
 */

import { DatabaseStorage } from "./database-storage";
import { JsonFileStorage } from "./backends/json-file-storage";
import { SqliteStorage } from "./backends/sqlite-storage";
import { PostgresStorage } from "./backends/postgres-storage";
import { configurationService } from "../configuration";
import { StorageConfig } from "../configuration/types";

export class StorageBackendFactory {
  /**
   * Create a storage backend instance based on configuration
   */
  static async create(workingDir?: string): Promise<DatabaseStorage<any, any>> {
    const config = await configurationService.loadConfiguration(workingDir || process.cwd());
    return this.createFromConfig(config.resolved.storage);
  }

  /**
   * Create a storage backend from resolved storage configuration
   */
  static createFromConfig(config: StorageConfig): DatabaseStorage<any, any> {
    switch (config.backend) {
    case "sqlite":
      return new SqliteStorage(config.dbPath, config.baseDir);
      
    case "postgres":
      if (!config.connectionString) {
        throw new Error("PostgreSQL connection string is required for postgres backend");
      }
      return new PostgresStorage(config.connectionString, config.baseDir);
      
    case "json":
    default:
      return new JsonFileStorage(config.dbPath, config.baseDir);
    }
  }

  /**
   * Validate backend configuration
   */
  static validateConfig(config: StorageConfig): string[] {
    const errors: string[] = [];

    if (!config.backend) {
      errors.push("Storage backend is required");
    }

    if (config.backend === "postgres" && !config.connectionString) {
      errors.push("PostgreSQL connection string is required for postgres backend");
    }

    return errors;
  }

  /**
   * Get available backends
   */
  static getAvailableBackends(): string[] {
    return ["json", "sqlite", "postgres"];
  }
} 

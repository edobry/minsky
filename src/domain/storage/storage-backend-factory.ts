/**
 * Storage Backend Factory
 * 
 * This module provides a factory for creating storage backends based on configuration.
 * Supports environment-based backend selection with fallback to JSON file storage.
 */

import type { DatabaseStorage } from "./database-storage";
import type { SessionRecord, SessionDbState } from "../session/session-db";
import { JsonFileStorage } from "./backends/json-file-storage";
import { SqliteStorage } from "./backends/sqlite-storage";
import { PostgresStorage } from "./backends/postgres-storage";
import { log } from "../../utils/logger";

/**
 * Supported storage backend types
 */
export type StorageBackendType = "json" | "sqlite" | "postgres";

/**
 * Configuration options for storage backends
 */
export interface StorageBackendConfig {
  type?: StorageBackendType;
  dbPath?: string;
  baseDir?: string;
  connectionString?: string;
}

/**
 * Factory for creating storage backends
 */
export class StorageBackendFactory {
  /**
   * Create a storage backend based on configuration
   */
  static create(config: StorageBackendConfig = {}): DatabaseStorage<SessionRecord, SessionDbState> {
    const backendType = config.type || this.getBackendTypeFromEnvironment();
    
    log.info(`Creating storage backend: ${backendType}`);
    
    switch (backendType) {
    case "sqlite":
      return new SqliteStorage(config.dbPath, config.baseDir);
    
    case "postgres":
      return new PostgresStorage(config.connectionString, config.baseDir);
    
    case "json":
    default:
      return new JsonFileStorage(config.dbPath, config.baseDir);
    }
  }

  /**
   * Get backend type from environment variables
   */
  private static getBackendTypeFromEnvironment(): StorageBackendType {
    const envBackend = process.env.MINSKY_SESSION_BACKEND;
    
    if (envBackend) {
      const normalizedBackend = envBackend.toLowerCase() as StorageBackendType;
      
      if (["json", "sqlite", "postgres"].includes(normalizedBackend)) {
        return normalizedBackend;
      } else {
        log.warn(`Invalid MINSKY_SESSION_BACKEND value: ${envBackend}. Using default: json`);
      }
    }
    
    return "json";
  }

  /**
   * Get configuration from environment variables
   */
  static getConfigFromEnvironment(): StorageBackendConfig {
    const type = this.getBackendTypeFromEnvironment();
    
    const config: StorageBackendConfig = { type };
    
    // Add type-specific configuration
    switch (type) {
    case "sqlite":
      if (process.env.MINSKY_SQLITE_PATH) {
        config.dbPath = process.env.MINSKY_SQLITE_PATH;
      }
      break;
    
    case "postgres":
      if (process.env.MINSKY_POSTGRES_URL) {
        config.connectionString = process.env.MINSKY_POSTGRES_URL;
      }
      break;
    
    case "json":
      if (process.env.MINSKY_JSON_PATH) {
        config.dbPath = process.env.MINSKY_JSON_PATH;
      }
      break;
    }
    
    if (process.env.MINSKY_BASE_DIR) {
      config.baseDir = process.env.MINSKY_BASE_DIR;
    }
    
    return config;
  }

  /**
   * Validate that required dependencies are available for the backend type
   */
  static validateBackendSupport(type: StorageBackendType): boolean {
    switch (type) {
    case "sqlite":
      try {
        require("better-sqlite3");
        require("drizzle-orm/better-sqlite3");
        return true;
      } catch {
        log.error("SQLite backend requires 'better-sqlite3' and drizzle SQLite support");
        return false;
      }
    
    case "postgres":
      try {
        require("pg");
        require("drizzle-orm/node-postgres");
        return true;
      } catch {
        log.error("PostgreSQL backend requires 'pg' and drizzle PostgreSQL support");
        return false;
      }
    
    case "json":
    default:
      return true; // JSON backend has no external dependencies
    }
  }

  /**
   * Create a storage backend with environment configuration and validation
   */
  static createFromEnvironment(): DatabaseStorage<SessionRecord, SessionDbState> {
    const config = this.getConfigFromEnvironment();
    
    // Validate backend support
    if (!this.validateBackendSupport(config.type!)) {
      log.warn(`Backend ${config.type} not supported, falling back to JSON`);
      config.type = "json";
    }
    
    return this.create(config);
  }
} 

/**
 * SessionDB Configuration Schema
 * 
 * Defines the schema for session database configuration including backend selection
 * and backend-specific connection parameters for JSON, SQLite, and PostgreSQL.
 */

import { z } from "zod";
import { baseSchemas, enumSchemas } from "./base";

/**
 * SessionDB backend selection
 */
export const sessionDbBackendSchema = enumSchemas.sessionDbBackend.default("sqlite");

/**
 * JSON backend configuration (file-based session storage)
 */
export const jsonSessionDbConfigSchema = z.object({
  // Base directory for session files (optional, uses XDG standard if not provided)
  baseDir: baseSchemas.directoryPath.optional(),
}).strict();

/**
 * SQLite backend configuration
 */
export const sqliteSessionDbConfigSchema = z.object({
  // SQLite database file path (optional, uses default location if not provided)
  path: baseSchemas.sqliteFilePath.optional(),
  
  // Base directory for SQLite database (optional, uses XDG standard if not provided)
  baseDir: baseSchemas.directoryPath.optional(),
}).strict();

/**
 * PostgreSQL backend configuration
 */
export const postgresSessionDbConfigSchema = z.object({
  // PostgreSQL connection string
  connectionString: baseSchemas.postgresConnectionString,
}).strict();

/**
 * Complete SessionDB configuration
 */
export const sessionDbConfigSchema = z.object({
  // Backend selection
  backend: sessionDbBackendSchema,
  
  // JSON backend configuration
  json: jsonSessionDbConfigSchema.optional(),
  
  // SQLite backend configuration
  sqlite: sqliteSessionDbConfigSchema.optional(),
  
  // PostgreSQL backend configuration
  postgres: postgresSessionDbConfigSchema.optional(),
  
  // Legacy fields (for backward compatibility)
  baseDir: baseSchemas.directoryPath.optional(),
  dbPath: baseSchemas.filePath.optional(),
  connectionString: baseSchemas.connectionString.optional(),
}).strict().transform((config) => {
  // Handle legacy field migration for backward compatibility
  const result = { ...config };
  
  // Migrate legacy baseDir to backend-specific config
  if (config.baseDir && !config.json?.baseDir && !config.sqlite?.baseDir) {
    if (config.backend === "json") {
      result.json = { ...config.json, baseDir: config.baseDir };
    } else if (config.backend === "sqlite") {
      result.sqlite = { ...config.sqlite, baseDir: config.baseDir };
    }
  }
  
  // Migrate legacy dbPath to SQLite config
  if (config.dbPath && config.backend === "sqlite" && !config.sqlite?.path) {
    result.sqlite = { ...config.sqlite, path: config.dbPath };
  }
  
  // Migrate legacy connectionString to PostgreSQL config
  if (config.connectionString && config.backend === "postgres" && !config.postgres?.connectionString) {
    result.postgres = { ...config.postgres, connectionString: config.connectionString };
  }
  
  return result;
});

// Type exports
export type SessionDbBackend = z.infer<typeof sessionDbBackendSchema>;
export type JsonSessionDbConfig = z.infer<typeof jsonSessionDbConfigSchema>;
export type SqliteSessionDbConfig = z.infer<typeof sqliteSessionDbConfigSchema>;
export type PostgresSessionDbConfig = z.infer<typeof postgresSessionDbConfigSchema>;
export type SessionDbConfig = z.infer<typeof sessionDbConfigSchema>;

/**
 * Validation functions for SessionDB configuration
 */
export const sessionDbValidation = {
  /**
   * Validate that a SessionDB backend name is supported
   */
  isValidBackend: (backend: string): backend is SessionDbBackend => {
    return ["json", "sqlite", "postgres"].includes(backend);
  },
  
  /**
   * Validate that PostgreSQL backend has connection string
   */
  hasPostgresConfig: (config: SessionDbConfig): boolean => {
    if (config.backend !== "postgres") return true;
    return !!(config.postgres?.connectionString || config.connectionString);
  },
  
  /**
   * Get the effective configuration for the selected backend
   */
  getBackendConfig: (config: SessionDbConfig) => {
    switch (config.backend) {
    case "json":
      return {
        type: "json" as const,
        baseDir: config.json?.baseDir || config.baseDir,
      };
      
    case "sqlite":
      return {
        type: "sqlite" as const,
        path: config.sqlite?.path || config.dbPath,
        baseDir: config.sqlite?.baseDir || config.baseDir,
      };
      
    case "postgres":
      return {
        type: "postgres" as const,
        connectionString: config.postgres?.connectionString || config.connectionString,
      };
      
    default:
      throw new Error(`Unsupported SessionDB backend: ${config.backend}`);
    }
  },
  
  /**
   * Validate that the configuration is complete for the selected backend
   */
  isConfigComplete: (config: SessionDbConfig): boolean => {
    const backendConfig = sessionDbValidation.getBackendConfig(config);
    
    switch (backendConfig.type) {
    case "json":
      return true; // JSON backend works with defaults
      
    case "sqlite":
      return true; // SQLite backend works with defaults
      
    case "postgres":
      return !!backendConfig.connectionString;
      
    default:
      return false;
    }
  },
} as const; 

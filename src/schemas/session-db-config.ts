/**
 * Session Database Configuration Schema Definitions
 * 
 * This module provides Zod schemas for validating session database configuration,
 * replacing unsafe `(config as unknown)` patterns with proper validation.
 */

import { z } from "zod";

/**
 * Session database backend types
 */
export const sessionDbBackendSchema = z.enum(["json", "sqlite", "postgres"]);

/**
 * Base session database configuration
 */
export const sessionDbConfigSchema = z.object({
  backend: sessionDbBackendSchema.default("json"),
  baseDir: z.string().optional(),
  dbPath: z.string().optional(),
  connectionString: z.string().optional(),
});

/**
 * Specific configuration for JSON backend
 */
export const jsonSessionDbConfigSchema = sessionDbConfigSchema.extend({
  backend: z.literal("json"),
  dbPath: z.string().optional(),
});

/**
 * Specific configuration for SQLite backend
 */
export const sqliteSessionDbConfigSchema = sessionDbConfigSchema.extend({
  backend: z.literal("sqlite"),
  dbPath: z.string().optional(),
});

/**
 * Specific configuration for PostgreSQL backend
 */
export const postgresSessionDbConfigSchema = sessionDbConfigSchema.extend({
  backend: z.literal("postgres"),
  connectionString: z.string().optional(),
});

/**
 * Union of all session database configurations
 */
export const sessionDbConfigUnionSchema = z.union([
  jsonSessionDbConfigSchema,
  sqliteSessionDbConfigSchema,
  postgresSessionDbConfigSchema,
]);

/**
 * Default session database configuration
 */
export const defaultSessionDbConfig = {
  backend: "json" as const,
  baseDir: undefined,
  dbPath: undefined,
  connectionString: undefined,
};

/**
 * Type inference for session database configurations
 */
export type SessionDbConfig = z.infer<typeof sessionDbConfigSchema>;
export type SessionDbBackend = z.infer<typeof sessionDbBackendSchema>;
export type JsonSessionDbConfig = z.infer<typeof jsonSessionDbConfigSchema>;
export type SqliteSessionDbConfig = z.infer<typeof sqliteSessionDbConfigSchema>;
export type PostgresSessionDbConfig = z.infer<typeof postgresSessionDbConfigSchema>;

/**
 * Validates and parses session database configuration
 */
export function validateSessionDbConfig(config: unknown): SessionDbConfig {
  try {
    return sessionDbConfigSchema.parse(config);
  } catch (error) {
    // Return default configuration if validation fails
    return defaultSessionDbConfig;
  }
}

/**
 * Validates configuration from node-config with fallback to defaults
 */
export function validateNodeConfig(nodeConfig: unknown): SessionDbConfig {
  if (!nodeConfig || typeof nodeConfig !== "object") {
    return defaultSessionDbConfig;
  }

  try {
    return sessionDbConfigSchema.parse(nodeConfig);
  } catch (error) {
    // Log validation failure and return defaults
    console.warn("Session database configuration validation failed, using defaults:", error);
    return defaultSessionDbConfig;
  }
}

/**
 * Checks if a configuration is valid for the specified backend
 */
export function isValidBackendConfig(config: SessionDbConfig, backend: SessionDbBackend): boolean {
  switch (backend) {
  case "json":
    return jsonSessionDbConfigSchema.safeParse(config).success;
  case "sqlite":
    return sqliteSessionDbConfigSchema.safeParse(config).success;
  case "postgres":
    return postgresSessionDbConfigSchema.safeParse(config).success;
  default:
    return false;
  }
}

/**
 * Gets validated configuration for specific backend
 */
export function getBackendConfig(config: SessionDbConfig, backend: SessionDbBackend) {
  switch (backend) {
  case "json":
    return jsonSessionDbConfigSchema.parse(config);
  case "sqlite":
    return sqliteSessionDbConfigSchema.parse(config);
  case "postgres":
    return postgresSessionDbConfigSchema.parse(config);
  default:
    throw new Error(`Invalid backend: ${backend}`);
  }
} 

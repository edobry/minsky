/**
 * Persistence Configuration Schema
 *
 * Defines the configuration schema for the PersistenceProvider system.
 * Supports PostgreSQL and SQLite storage backends.
 */

import { z } from "zod";

/**
 * PostgreSQL persistence configuration schema
 */
const postgresConfigSchema = z.object({
  connectionString: z.string(),
  maxConnections: z.number().min(1).max(100).optional(),
  // connectTimeout: seconds (1–300). Passed directly to postgres-js connect_timeout
  // which is a seconds value. Using seconds avoids a conversion at the provider boundary.
  connectTimeout: z.number().min(1).max(300).optional(), // 1s - 5min
  // idleTimeout: seconds (1–600). Passed directly to postgres-js idle_timeout
  // which is a seconds value. Using seconds avoids a conversion at the provider boundary.
  idleTimeout: z.number().min(1).max(600).optional(), // 1s - 10min
  prepareStatements: z.boolean().optional(),
});

/**
 * SQLite persistence configuration schema
 */
const sqliteConfigSchema = z.object({
  dbPath: z.string(),
});

/**
 * Persistence provider backend types
 */
export const persistenceBackendSchema = z.enum(["postgres", "sqlite"]);

/**
 * Main persistence configuration schema
 */
export const persistenceConfigSchema = z.object({
  backend: persistenceBackendSchema,
  postgres: postgresConfigSchema.optional(),
  sqlite: sqliteConfigSchema.optional(),
});

/**
 * TypeScript types inferred from schemas
 */
export type PersistenceBackend = z.infer<typeof persistenceBackendSchema>;
export type PostgresConfig = z.infer<typeof postgresConfigSchema>;
export type SqliteConfig = z.infer<typeof sqliteConfigSchema>;
export type PersistenceConfig = z.infer<typeof persistenceConfigSchema>;

/**
 * Validation helper for persistence configuration
 */
export const persistenceValidation = {
  /**
   * Validate that the configuration has the required backend-specific options
   */
  validateBackendConfig: (config: PersistenceConfig): { valid: boolean; errors: string[] } => {
    const errors: string[] = [];

    switch (config.backend) {
      case "postgres":
        if (!config.postgres?.connectionString) {
          errors.push("PostgreSQL backend requires connectionString");
        }
        break;
      case "sqlite":
        if (!config.sqlite?.dbPath) {
          errors.push("SQLite backend requires dbPath");
        }
        break;
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  },
} as const;

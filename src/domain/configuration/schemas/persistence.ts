/**
 * Persistence Configuration Schema
 *
 * Defines the configuration schema for the PersistenceProvider system.
 * Supports PostgreSQL and SQLite storage backends.
 */

import { z } from "zod";

/**
 * Returns a Zod schema for a seconds-scale timeout field.
 *
 * Validation order inside superRefine (runs after .min(1) passes):
 * 1. Value >= 1000 → looks like a milliseconds value from the old API; emit a
 *    migration message with the seconds-equivalent. This takes priority so the
 *    user sees the actionable hint rather than a generic "too big" message.
 * 2. Value > maxSeconds (but < 1000) → standard out-of-range message.
 * 3. Value in [1, maxSeconds] → valid.
 */
function secondsTimeoutSchema(fieldName: string, maxSeconds: number) {
  return z
    .number()
    .int()
    .min(1)
    .superRefine((val, ctx) => {
      if (val >= 1000) {
        const secondsEquiv = Math.round(val / 1000);
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${fieldName} is now in seconds (was milliseconds). ${val} ms ≈ ${secondsEquiv} s — try ${fieldName}: ${secondsEquiv}`,
        });
      } else if (val > maxSeconds) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Number must be less than or equal to ${maxSeconds}`,
        });
      }
    });
}

/**
 * PostgreSQL persistence configuration schema
 */
const postgresConfigSchema = z.object({
  connectionString: z.string(),
  maxConnections: z.number().min(1).max(100).optional(),
  // connectTimeout: seconds (1–300). Passed directly to postgres-js connect_timeout
  // which is a seconds value. Using seconds avoids a conversion at the provider boundary.
  connectTimeout: secondsTimeoutSchema("connectTimeout", 300).optional(), // 1s - 5min
  // idleTimeout: seconds (1–600). Passed directly to postgres-js idle_timeout
  // which is a seconds value. Using seconds avoids a conversion at the provider boundary.
  idleTimeout: secondsTimeoutSchema("idleTimeout", 600).optional(), // 1s - 10min
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

/**
 * Drizzle Kit config for the reviewer service.
 *
 * Owns ONLY reviewer-side schemas. Outputs migrations to
 * services/reviewer/migrations/pg/ — independent of the root Minsky
 * migration folder (src/domain/storage/migrations/pg/).
 *
 * Connection string resolution mirrors root drizzle.pg.config.ts.
 * Inlined here to keep the reviewer package sealed (no imports from src/).
 */

import type { Config } from "drizzle-kit";

/**
 * Get Postgres connection string from environment variables.
 *
 * Priority:
 * 1. MINSKY_SESSIONDB_POSTGRES_URL (set by Minsky migration commands)
 * 2. MINSKY_POSTGRES_URL (direct env override)
 * 3. Development fallback
 */
function getPostgresConnectionString(): string {
  const envUrl = process.env.MINSKY_SESSIONDB_POSTGRES_URL || process.env.MINSKY_POSTGRES_URL;
  if (envUrl) {
    return envUrl;
  }

  // Development fallback
  return "postgresql://localhost:5432/minsky";
}

export default {
  schema: ["./src/db/schemas/convergence-metrics-schema.ts"],
  out: "./migrations/pg",
  dialect: "postgresql",
  dbCredentials: {
    url: getPostgresConnectionString(),
  },
} satisfies Config;

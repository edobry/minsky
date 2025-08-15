import type { Config } from "drizzle-kit";

// Helper function to get PostgreSQL connection string from Minsky config system
function getPostgresConnectionString(): string {
  // Environment variables set by Minsky's sessiondb migrate command
  // which loads the full configuration system and exports the necessary values

  // 1. Check for Minsky-loaded database config (set by migration command)
  if (process.env.MINSKY_DB_CONFIG) {
    try {
      const dbConfig = JSON.parse(process.env.MINSKY_DB_CONFIG);
      if (dbConfig.postgres?.connectionString) {
        return dbConfig.postgres.connectionString;
      }
    } catch (error) {
      console.warn("Failed to parse MINSKY_DB_CONFIG:", error);
    }
  }

  // 2. Fall back to direct environment variables
  const envUrl = process.env.MINSKY_SESSIONDB_POSTGRES_URL || process.env.MINSKY_POSTGRES_URL;
  if (envUrl) {
    return envUrl;
  }

  // 3. Development fallback
  return "postgresql://localhost:5432/minsky";
}

export default {
  schema: [
    "./src/domain/storage/schemas/session-schema.ts",
    "./src/domain/storage/schemas/task-embeddings.ts",
  ],
  out: "./src/domain/storage/migrations/pg",
  dialect: "postgresql",
  dbCredentials: {
    // Load connection string from Minsky configuration system via environment variables
    url: getPostgresConnectionString(),
  },
} satisfies Config;

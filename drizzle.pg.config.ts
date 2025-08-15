import type { Config } from "drizzle-kit";
import { loadConfiguration } from "./src/domain/configuration/loader.js";

// Helper function to get PostgreSQL connection string from Minsky config
async function getPostgresConnectionString(): Promise<string> {
  try {
    const configResult = await loadConfiguration();
    const config = configResult.config;

    // Check for PostgreSQL connection string in config
    if (config.sessiondb?.postgres?.connectionString) {
      return config.sessiondb.postgres.connectionString;
    }

    // Fallback to environment variable (for backwards compatibility)
    if (process.env.MINSKY_SESSIONDB_POSTGRES_URL) {
      return process.env.MINSKY_SESSIONDB_POSTGRES_URL;
    }

    // Last resort fallback for development
    return "postgresql://localhost:5432/minsky";
  } catch (error) {
    console.warn("Failed to load Minsky configuration, using fallback connection string:", error);
    return process.env.MINSKY_SESSIONDB_POSTGRES_URL || "postgresql://localhost:5432/minsky";
  }
}

export default {
  schema: [
    "./src/domain/storage/schemas/session-schema.ts",
    "./src/domain/storage/schemas/task-embeddings.ts",
  ],
  out: "./src/domain/storage/migrations/pg",
  dialect: "postgresql",
  dbCredentials: {
    // Load connection string from Minsky configuration system
    url: await getPostgresConnectionString(),
  },
} satisfies Config;

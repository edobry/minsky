import type { Config } from "drizzle-kit";

// Helper function to get PostgreSQL connection string from Minsky config
function getPostgresConnectionString(): string {
  // Since drizzle-kit loads this synchronously, we need to fall back to environment variables
  // The async config loading will be handled by the migration command itself
  const envUrl = process.env.MINSKY_SESSIONDB_POSTGRES_URL || process.env.MINSKY_POSTGRES_URL;

  if (envUrl) {
    return envUrl;
  }

  // Fallback for development
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
    // Load connection string from environment variables (Minsky config system sets these)
    url: getPostgresConnectionString(),
  },
} satisfies Config;

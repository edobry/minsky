// tsyringe (transitively imported via schema chain → configuration/backend-detection)
// requires reflect-metadata to be loaded at the drizzle-kit subprocess entry point.
import "reflect-metadata";
import type { Config } from "drizzle-kit";
import { execSync } from "child_process";

// Helper function to get PostgreSQL connection string from Minsky config system
function getPostgresConnectionString(): string {
  // Environment variables set by Minsky's persistence migrate command
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
  const envUrl = process.env.MINSKY_PERSISTENCE_POSTGRES_URL || process.env.MINSKY_POSTGRES_URL;
  if (envUrl) {
    return envUrl;
  }

  // 3. Load from Minsky configuration system using helper script
  // This handles standalone drizzle-kit commands
  try {
    const configOutput = execSync("bun ./scripts/drizzle-config-loader.ts", {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
    });
    const dbConfig = JSON.parse(configOutput.trim());
    if (dbConfig.postgres?.connectionString) {
      return dbConfig.postgres.connectionString;
    }
  } catch (error) {
    console.warn("Failed to load Minsky configuration via helper script:", error);
  }

  // 4. Development fallback
  return "postgresql://localhost:5432/minsky";
}

export default {
  schema: [
    "./packages/domain/src/storage/schemas/session-schema.ts",
    "./packages/domain/src/storage/schemas/task-embeddings.ts",
    "./packages/domain/src/storage/schemas/rule-embeddings.ts",
    "./packages/domain/src/storage/schemas/task-relationships.ts",
    "./packages/domain/src/storage/schemas/provenance-schema.ts",
    "./packages/domain/src/storage/schemas/agent-transcripts-schema.ts",
    "./packages/domain/src/storage/schemas/agent-transcript-turns-schema.ts",
    "./packages/domain/src/storage/schemas/agent-spawns-schema.ts",
    "./packages/domain/src/storage/schemas/minsky-session-links-schema.ts",
    "./packages/domain/src/storage/schemas/ask-schema.ts",
    "./packages/domain/src/storage/schemas/pr-watch-schema.ts",
    "./packages/domain/src/storage/schemas/subagent-invocations-schema.ts",
    "./packages/domain/src/storage/schemas/knowledge-embeddings.ts",
    "./packages/domain/src/storage/schemas/memory-embeddings.ts",
    "./packages/domain/src/storage/schemas/oauth-schema.ts",
    "./packages/domain/src/storage/schemas/tool-embeddings.ts",
    "./packages/domain/src/storage/schemas/wake-pending-schema.ts",
    "./packages/domain/src/storage/schemas/system-events-schema.ts",
    "./src/domain/detectors/dismissal-store.ts",
  ],
  out: "./packages/domain/src/storage/migrations/pg",
  dialect: "postgresql",
  dbCredentials: {
    // Load connection string from Minsky configuration system via environment variables
    url: getPostgresConnectionString(),
  },
} satisfies Config;

// tsyringe (transitively imported via schema chain → configuration/backend-detection)
// requires reflect-metadata to be loaded at the drizzle-kit subprocess entry point.
import "reflect-metadata";
import type { Config } from "drizzle-kit";
import { execSync } from "child_process";

// Helper function to get PostgreSQL connection string from Minsky config system
//
// Forward note (mt#4017 gate (l)): this reads the connection string via a
// subprocess (scripts/drizzle-config-loader.ts, whose stdout is now GATED —
// see that script) specifically because drizzle-kit 0.31.2's `defineConfig`
// has no top-level-await support, so this file can't just `await` the
// config in-process. drizzle-team/drizzle-orm#4075 (shipped 1.0.0-beta.13)
// added support for `defineConfig` to accept a promise or a function
// returning one. On a future drizzle-kit 1.x upgrade, the correct move is
// to DELETE the loader subprocess entirely and resolve the connection
// string in-process — not to keep gating it.
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
  //
  // MINSKY_DRIZZLE_LOADER_GATE is the sanctioned-caller signal
  // scripts/drizzle-config-loader.ts requires before it will print anything
  // (mt#4017) — that script's stdout is a live credential, and without this
  // gate it refuses and exits non-zero rather than emit it. Only THIS
  // execSync call (drizzle-kit's own subprocess, never a Bash/session_exec
  // tool call an agent issues) is meant to set it.
  try {
    const configOutput = execSync("bun ./scripts/drizzle-config-loader.ts", {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
      env: { ...process.env, MINSKY_DRIZZLE_LOADER_GATE: "1" },
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
    "./packages/domain/src/storage/schemas/projects-schema.ts",
    "./packages/domain/src/storage/schemas/session-schema.ts",
    "./packages/domain/src/storage/schemas/task-embeddings.ts",
    "./packages/domain/src/storage/schemas/rule-embeddings.ts",
    "./packages/domain/src/storage/schemas/task-relationships.ts",
    "./packages/domain/src/storage/schemas/provenance-schema.ts",
    "./packages/domain/src/storage/schemas/agent-transcripts-schema.ts",
    "./packages/domain/src/storage/schemas/agent-transcript-turns-schema.ts",
    "./packages/domain/src/storage/schemas/transcript-lines-schema.ts",
    "./packages/domain/src/storage/schemas/agent-spawns-schema.ts",
    "./packages/domain/src/storage/schemas/agent-tool-call-projection-schema.ts",
    "./packages/domain/src/storage/schemas/minsky-session-links-schema.ts",
    "./packages/domain/src/storage/schemas/driven-session-cost-schema.ts",
    "./packages/domain/src/storage/schemas/driven-sessions-schema.ts",
    "./packages/domain/src/storage/schemas/entity-threads-schema.ts",
    "./packages/domain/src/storage/schemas/ask-schema.ts",
    "./packages/domain/src/storage/schemas/pr-watch-schema.ts",
    "./packages/domain/src/storage/schemas/subagent-invocations-schema.ts",
    "./packages/domain/src/storage/schemas/knowledge-embeddings.ts",
    "./packages/domain/src/storage/schemas/memory-embeddings.ts",
    "./packages/domain/src/storage/schemas/oauth-schema.ts",
    "./packages/domain/src/storage/schemas/tool-embeddings.ts",
    "./packages/domain/src/storage/schemas/wake-pending-schema.ts",
    "./packages/domain/src/storage/schemas/system-events-schema.ts",
    "./packages/domain/src/detectors/dismissal-store.ts",
    "./packages/domain/src/storage/schemas/presence-claims-schema.ts",
    "./packages/domain/src/storage/schemas/scheduled-follow-ups-schema.ts",
    "./packages/domain/src/storage/schemas/task-supervisions-schema.ts",
    "./packages/domain/src/storage/schemas/conversation-run-state-schema.ts",
    "./packages/domain/src/storage/schemas/engprod-proposal-ledger-schema.ts",
    "./packages/domain/src/storage/schemas/telegram-channel-topics-schema.ts",
    "./packages/domain/src/storage/schemas/guard-canary-runs-schema.ts",
    "./packages/domain/src/storage/schemas/cockpit-auth-schema.ts",
    "./packages/domain/src/storage/schemas/guard-events-schema.ts",
    "./packages/domain/src/storage/schemas/conversation-shares-schema.ts",
  ],
  out: "./packages/domain/src/storage/migrations/pg",
  dialect: "postgresql",
  dbCredentials: {
    // Load connection string from Minsky configuration system via environment variables
    url: getPostgresConnectionString(),
  },
} satisfies Config;

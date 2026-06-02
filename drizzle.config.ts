import type { Config } from "drizzle-kit";

// Default config remains SQLite-focused for local development.
// A separate pg config file will be used for PostgreSQL migrations.
export default {
  schema: "./packages/domain/src/storage/schemas/session-schema.ts",
  out: "./packages/domain/src/storage/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: "file:sessions.db",
  },
} satisfies Config;

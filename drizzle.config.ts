import type { Config } from "drizzle-kit";

// Default config remains SQLite-focused for local development.
// A separate pg config file will be used for PostgreSQL migrations.
export default {
  schema: "./src/domain/storage/schemas/session-schema.ts",
  out: "./src/domain/storage/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: "file:sessions.db",
  },
} satisfies Config;

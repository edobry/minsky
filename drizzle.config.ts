import type { Config } from "drizzle-kit";

export default {
  schema: "./src/domain/storage/schemas/session-schema.ts",
  out: "./src/domain/storage/migrations",
  dialect: "sqlite", // Default dialect for migrations
  dbCredentials: {
    url: "file:sessions.db",
  },
} satisfies Config;

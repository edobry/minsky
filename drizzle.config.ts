<<<<<<< HEAD
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./src/domain/storage/migrations",
  schema: "./src/domain/storage/schemas/*.ts",
  dialect: "sqlite",
}); 
=======
import type { Config } from "drizzle-kit";

export default {
  schema: "./src/domain/storage/schemas/session-schema.ts",
  out: "./src/domain/storage/migrations",
  dialect: "sqlite", // Default dialect for migrations
  dbCredentials: {
    url: "file:sessions.db",
  },
} satisfies Config;
>>>>>>> origin/main

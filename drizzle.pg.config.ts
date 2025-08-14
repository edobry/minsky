import type { Config } from "drizzle-kit";

export default {
  schema: [
    "./src/domain/storage/schemas/session-schema.ts",
    "./src/domain/storage/schemas/task-embeddings.ts",
  ],
  out: "./src/domain/storage/migrations/pg",
  dialect: "postgresql",
  dbCredentials: {
    // Used by some drizzle-kit commands; generation doesn't require a live DB
    url: (process.env as any).MINSKY_POSTGRES_URL || "postgresql://localhost:5432/minsky",
  },
} satisfies Config;

import { pgTable, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";

// Drizzle schema for task_embeddings (PostgreSQL)
// Note: pgvector column type is not provided by drizzle-orm core; we keep it as raw SQL in migrations
export const taskEmbeddings = pgTable("task_embeddings", {
  id: text("id").primaryKey(),
  taskId: text("task_id"),
  dimension: integer("dimension").notNull(),
  // embedding vector(<dimension>) created via raw SQL in migration
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

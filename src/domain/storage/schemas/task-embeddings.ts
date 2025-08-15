import { pgTable, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { vector } from "drizzle-orm/pg-core";

// Drizzle schema for task_embeddings (PostgreSQL)
export const taskEmbeddings = pgTable(
  "task_embeddings",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id"), // Renamed from qualified_task_id
    dimension: integer("dimension").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }), // Add the vector column
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_task_embeddings_ivf").using(
      "ivfflat",
      table.embedding.asc().nullsLast().op("vector_l2_ops")
    ),
  ]
);

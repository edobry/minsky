import { pgTable, text, integer, timestamp, jsonb, index, pgEnum } from "drizzle-orm/pg-core";
import { vector } from "drizzle-orm/pg-core";
import { enumSchemas } from "../../configuration/schemas/base";

// Enumerated task status matching markdown backend
export const taskStatusEnum = pgEnum("task_status", [
  "TODO",
  "IN-PROGRESS",
  "IN-REVIEW",
  "DONE",
  "BLOCKED",
  "CLOSED",
]);

// Enumerated backend type (reuse centralized backend type values)
const BACKEND_VALUES = enumSchemas.backendType.options as [string, ...string[]];
export const taskBackendEnum = pgEnum("task_backend", BACKEND_VALUES);

// Drizzle schema for tasks (metadata only)
export const tasksTable = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    sourceTaskId: text("source_task_id"),
    backend: taskBackendEnum("backend"),
    status: taskStatusEnum("status"),
    title: text("title"),
    spec: text("spec"),
    contentHash: text("content_hash"),
    lastIndexedAt: timestamp("last_indexed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  () => []
);

// Drizzle schema for tasks embeddings (vectors only)
// Separate from `tasks` metadata for clear responsibility boundaries
export const tasksEmbeddingsTable = pgTable(
  "tasks_embeddings",
  {
    taskId: text("task_id").primaryKey(),
    dimension: integer("dimension").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }),
    lastIndexedAt: timestamp("last_indexed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_tasks_embeddings_hnsw").using(
      "hnsw",
      table.embedding.asc().nullsLast().op("vector_l2_ops")
    ),
  ]
);

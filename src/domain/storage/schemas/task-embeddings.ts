import { pgTable, text, integer, timestamp, index, pgEnum } from "drizzle-orm/pg-core";
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

// Drizzle schema for tasks (metadata only - no spec content)
export const tasksTable = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    sourceTaskId: text("source_task_id"),
    backend: taskBackendEnum("backend"),
    status: taskStatusEnum("status"),
    title: text("title"),
    contentHash: text("content_hash"),
    lastIndexedAt: timestamp("last_indexed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  () => []
);

// Drizzle schema for task specifications (content only)
export const taskSpecsTable = pgTable(
  "task_specs",
  {
    taskId: text("task_id").primaryKey(),
    content: text("content").notNull(),
    contentHash: text("content_hash"),
    version: integer("version").default(1),
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
    vector: vector("vector", { dimensions: 1536 }),
    metadata: text("metadata"), // JSON metadata as text
    contentHash: text("content_hash"),
    indexedAt: timestamp("indexed_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_tasks_embeddings_hnsw").using(
      "hnsw",
      table.vector.asc().nullsLast().op("vector_l2_ops")
    ),
  ]
);

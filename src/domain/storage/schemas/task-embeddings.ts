import { pgTable, text, integer, timestamp, index, pgEnum } from "drizzle-orm/pg-core";
import { vector } from "drizzle-orm/pg-core";
import { enumSchemas } from "../../configuration/schemas/base";
import { createEmbeddingsTable, EMBEDDINGS_CONFIGS } from "./embeddings-schema-factory";

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
    version: integer("version").default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  () => []
);

// Drizzle schema for tasks embeddings (vectors + denormalized filter columns)
// Uses standardized embeddings schema factory for consistency with rules_embeddings
// Includes denormalized status and backend columns for server-side filtering
export const tasksEmbeddingsTable = createEmbeddingsTable({
  ...EMBEDDINGS_CONFIGS.tasks,
  domainColumns: {
    status: taskStatusEnum("status"),
    backend: taskBackendEnum("backend"),
  },
});

import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { vector } from "drizzle-orm/pg-core";

// Enumerated task status matching markdown backend
export const taskStatusEnum = pgEnum("task_status", [
  "TODO",
  "IN-PROGRESS",
  "IN-REVIEW",
  "DONE",
  "BLOCKED",
  "CLOSED",
]);

// Drizzle schema for tasks (renamed from task_embeddings)
export const tasksTable = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id"),
    status: taskStatusEnum("status"),
    title: text("title"),
    spec: text("spec"),
    dimension: integer("dimension").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }),
    metadata: jsonb("metadata"),
    contentHash: text("content_hash"),
    lastIndexedAt: timestamp("last_indexed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_tasks_hnsw").using("hnsw", table.embedding.asc().nullsLast().op("vector_l2_ops")),
    uniqueIndex("uq_tasks_task_id").on(table.taskId),
  ]
);

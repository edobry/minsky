import { pgTable, text, integer, timestamp, pgEnum, uuid } from "drizzle-orm/pg-core";
import { TaskStatus } from "../../tasks/taskConstants";
import { enumSchemas } from "../../configuration/schemas/base";
import { createEmbeddingsTable, EMBEDDINGS_CONFIGS } from "./embeddings-schema-factory";

// Enumerated task status using centralized TaskStatus enum
export const taskStatusEnum = pgEnum(
  "task_status",
  Object.values(TaskStatus) as [string, ...string[]]
);

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
    tags: text("tags").default("[]"), // JSON-serialized string[]
    kind: text("kind").default("implementation").notNull(), // Task workflow kind: "implementation" | "umbrella"
    lastIndexedAt: timestamp("last_indexed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    // Project scoping (mt#2415, Phase 1.2). Nullable; backfilled to the Minsky
    // project; NOT NULL deferred to Phase 1.3 (mt#2416).
    // Plain uuid column — no DB-level FK per project convention (ask-schema.ts).
    projectId: uuid("project_id"),
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

// Drizzle schema for deleted-task-ID tombstones (mt#2205).
// Records every task ID that has ever been deleted so the minsky backend's
// ID allocator can compute a monotonic high-water mark over live tasks UNION
// these tombstones — a freed ID is never re-handed-out. deleteTask hard-purges
// the live data rows (tasks, task_specs, tasks_embeddings) and inserts a row
// here to anchor the high-water mark.
export const deletedTaskIdsTable = pgTable(
  "deleted_task_ids",
  {
    id: text("id").primaryKey(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }).defaultNow().notNull(),
  },
  () => []
);

// Drizzle schema for tasks embeddings (vectors only)
// Uses standardized embeddings schema factory for consistency with rules_embeddings.
// The denormalized status/backend columns were removed in migration 0044 (mt#2250):
// ADR-013 (mt#2220) moved task similarity search to read-time domain filtering via a
// JOIN to the live `tasks` table, making these columns vestigial (and the source of
// the mt#2220 NULL-status bug). The `task_status` / `task_backend` enums above are
// retained because the `tasks` table still uses them.
export const tasksEmbeddingsTable = createEmbeddingsTable({
  ...EMBEDDINGS_CONFIGS.tasks,
});

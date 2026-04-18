import { pgTable, text, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Task relationships — typed edges between tasks
 * - "depends": A depends on B (sequencing)
 * - "parent": A is a child of B (composition)
 * - Qualified IDs only (e.g., mt#123, gh#200)
 */
export const taskRelationshipsTable = pgTable(
  "task_relationships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fromTaskId: text("from_task_id").notNull(),
    toTaskId: text("to_task_id").notNull(),
    type: text("type").notNull().default("depends"),
  },
  (table) => ({
    // Prevent duplicate edges of the same type
    uniqueEdge: uniqueIndex("tr_unique_edge").on(table.fromTaskId, table.toTaskId, table.type),
    // Fast lookups
    byFrom: index("tr_from_idx").on(table.fromTaskId),
    byTo: index("tr_to_idx").on(table.toTaskId),
    // Enforce at most one parent per child task
    oneParent: uniqueIndex("tr_one_parent")
      .on(table.fromTaskId)
      .where(sql`type = 'parent'`),
  })
);

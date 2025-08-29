import { pgTable, text, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Task relationships (MVP: single edge type = depends)
 * - Qualified IDs only (e.g., md#123, db#200)
 * - No timestamps in MVP
 */
export const taskRelationshipsTable = pgTable(
  "task_relationships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fromTaskId: text("from_task_id").notNull(),
    toTaskId: text("to_task_id").notNull(),
  },
  (table) => ({
    // Prevent duplicate edges
    uniqueEdge: uniqueIndex("tr_unique_edge").on(table.fromTaskId, table.toTaskId),
    // Fast lookups
    byFrom: index("tr_from_idx").on(table.fromTaskId),
    byTo: index("tr_to_idx").on(table.toTaskId),
    // Self-edge guard via check constraint
    // Drizzle doesn't expose check builder here for pg-core indexes block; instead enforced in migration
    // Additional runtime validation is implemented in service
  })
);

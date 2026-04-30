import { pgTable, text, uuid, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Task relationships — typed edges between tasks
 * - "depends": A depends on B (sequencing)
 * - "parent": A is a child of B (composition)
 * - Qualified IDs only (e.g., mt#123, gh#200)
 *
 * RELATIONSHIP_TYPE_VALUES is the single source of truth for valid type values.
 * The CHECK constraint below rejects unknown values at the DB level.
 * task-graph-service.ts imports this const and derives RelationshipType from it.
 */

/**
 * Single source of truth for all valid task relationship type values.
 * The CHECK constraint below and RelationshipType in task-graph-service.ts
 * both derive from this const. Adding a value here without a migration is
 * caught by the drift-check test in enum-drift.test.ts.
 */
export const RELATIONSHIP_TYPE_VALUES = ["depends", "parent"] as const;

/**
 * Named constant for the "parent" relationship type, used in the unique-index
 * WHERE clause below. Derived from RELATIONSHIP_TYPE_VALUES so that any rename
 * or removal is caught by TypeScript at compile time rather than silently
 * diverging.
 *
 * The TS-level assertion (`satisfies`) ensures this value is always a member
 * of RELATIONSHIP_TYPE_VALUES; if "parent" is removed or renamed in the const,
 * this line will produce a compile error.
 */
export const PARENT_RELATIONSHIP_TYPE =
  "parent" satisfies (typeof RELATIONSHIP_TYPE_VALUES)[number];

/** SQL expression for the type CHECK constraint — derived from RELATIONSHIP_TYPE_VALUES */
const typeCheckSql = sql.raw(
  `type IN (${RELATIONSHIP_TYPE_VALUES.map((v) => `'${v}'`).join(", ")})`
);

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
    // Enforce at most one parent per child task.
    // PARENT_RELATIONSHIP_TYPE is derived from RELATIONSHIP_TYPE_VALUES, so any
    // rename of "parent" in the const will cause a TS compile error here first.
    oneParent: uniqueIndex("tr_one_parent")
      .on(table.fromTaskId)
      .where(sql.raw(`type = '${PARENT_RELATIONSHIP_TYPE}'`)),
    // Enum guard: reject unknown type values at DB level
    typeCheck: check("chk_task_relationships_type", typeCheckSql),
  })
);

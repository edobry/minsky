import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects-schema";

/**
 * Standing pointings (mt#5129 — Prioritization Phase 1b; RFC 3ae937f0).
 *
 * A pointing is the DEFINITION only: a saved query over fields that exist
 * today, plus the autonomy class and WIP limit the principal declares with it.
 * Nothing computed lives here — no candidate set, no WIP count, no queue. The
 * candidate set is evaluated at read time (`pointings.candidates`), which is
 * what keeps this below the RFC's entity-promotion trigger ("cross-session
 * state a query can't compute" — deferred to Phase 3 cold dispatch).
 *
 * "Standing pointing" is a placeholder name; the principal has not picked one.
 * No user-facing label is introduced by this table — identifiers only.
 */

/** The three computed autonomy classes the RFC defines; `principal-gated` dominates. */
export const POINTING_AUTONOMY_CLASSES = ["principal-gated", "pull-only", "contained"] as const;
export type PointingAutonomyClass = (typeof POINTING_AUTONOMY_CLASSES)[number];

/**
 * A saved query. Fields are OR-ed (union): a task matches when it carries any
 * listed tag, OR sits anywhere under any listed parent, OR is listed by id.
 * At least one field must be non-empty (`isEmptyPointingQuery`).
 */
export interface PointingQuery {
  tags?: string[];
  parentIds?: string[];
  taskIds?: string[];
}

export const pointingsTable = pgTable(
  "pointings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Principal-facing name; unique among LIVE pointings within a project. */
    name: text("name").notNull(),
    query: jsonb("query").$type<PointingQuery>().notNull(),
    /** One of POINTING_AUTONOMY_CLASSES. Text (not pgEnum), matching the kind column's convention. */
    autonomyClass: text("autonomy_class").notNull().default("pull-only"),
    /** Phase 2's pull-time admission bound; stored now so a declaration is complete. */
    wipLimit: integer("wip_limit").notNull().default(1),
    projectId: uuid("project_id").references(() => projectsTable.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    /** Set on archive; a pointing is never deleted, so its history stays citable. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    index("pointings_project_id_idx").on(table.projectId),
    // One live pointing per name per project; archived rows may reuse the name.
    uniqueIndex("pointings_project_name_live_idx")
      .on(table.projectId, table.name)
      .where(sql`archived_at IS NULL`),
  ]
);

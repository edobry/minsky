import { pgTable, text, uuid, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Projects table — the project-identity entity (mt#2415, Phase 1.2 of mt#2391).
 *
 * Introduces normalized project identity so one Postgres can hold multiple
 * projects without interleaving (RFC "Minsky beyond Minsky", Notion
 * 37a937f0-3cb4-81ed-9a08-fbdeebd8845d, Amendment 2026-06-16 — Design A).
 *
 * Conventions:
 * - **Surrogate uuid PK** with `defaultRandom()` — stable identity. The `slug`
 *   (e.g. `owner/repo`) is human-readable but CHANGES on fork/rename, so it is a
 *   unique mutable column, NOT the primary key (a slug PK would orphan every
 *   `project_id`-scoped row on a rename). See mt#2414 for the slug resolver.
 * - `repo_url` is the canonical home for the project's repo URL (sessions keep a
 *   denormalized cache for the clone/push hot path; the project row is canonical).
 * - `display_name` optional; `created_at` withTimezone.
 * - Extensible: an `owner`/`principal` FK is an additive migration when the
 *   account layer activates (RFC horizon — deliberately not built now).
 */
export const projectsTable = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull().unique(),
    repoUrl: text("repo_url"),
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("idx_projects_slug").on(table.slug)]
);

export type ProjectRecord = typeof projectsTable.$inferSelect;
export type ProjectInsert = typeof projectsTable.$inferInsert;

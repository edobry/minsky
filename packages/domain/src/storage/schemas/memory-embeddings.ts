/**
 * Memory Storage Schemas
 *
 * Two-table design following the project standard:
 *   - memories: domain table (content, metadata, lineage)
 *   - memories_embeddings: vectors only (via embeddings schema factory)
 *
 * The embeddings table uses HNSW + vector_l2_ops, consistent with all other
 * embeddings tables in the project. The spec mentioned ivfflat/cosine, but HNSW
 * is the project-wide standard (established in embeddings-schema-factory.ts).
 */

import {
  pgTable,
  text,
  real,
  integer,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
  uuid,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createEmbeddingsTable } from "./embeddings-schema-factory";
import { MEMORY_TYPE_VALUES } from "../../memory/types";
import { shortIdColumn } from "./short-id-column";

// Postgres enums for memory type and scope
// MEMORY_TYPE_VALUES is the single source of truth — adding a value there
// without a migration is caught by the drift-check test.
export const memoryTypeEnum = pgEnum("memory_type", MEMORY_TYPE_VALUES);
export const memoryScopeEnum = pgEnum("memory_scope", ["project", "user", "cross_project"]);

/**
 * Primary memories table.
 * Stores the domain entity (content, metadata, lineage).
 */
export const memoriesTable = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /**
     * Numeric `mem#N` short id (mt#2966, ADR-029) — added alongside the
     * canonical uuid PK above, never replacing it. Nullable text; NULL until
     * minted on create (new rows) or backfilled
     * (`scripts/backfill-memory-short-ids.ts`, existing rows). See
     * `../short-id-column.ts` for the general design rationale
     * (nullable-not-backfilled-here, concurrency contract).
     *
     * The unique index on this column (`idx_memories_short_id_unique`,
     * declared below in the index-builder callback) is PARTIAL — `WHERE
     * short_id IS NOT NULL` — for explicit NULL semantics + planner clarity
     * (PR #2134 R2). Postgres unique indexes already treat NULLs as
     * distinct from each other, so an all-NULL `short_id` column during the
     * pre-backfill window is safe either way; the WHERE clause just makes
     * that intent explicit and keeps the index small (entries only for
     * backfilled/minted rows).
     *
     * Declared directly via `uniqueIndex(...).on(...).where(sql\`...\`)`
     * (drizzle-orm's `IndexBuilder.where()`, confirmed supported by this
     * project's drizzle-orm version — see `pr-watch-schema.ts`'s
     * `idx_pr_watches_parent_session` for an existing partial-index
     * precedent) rather than the shared `shortIdUniqueIndex()` foundation
     * helper (`short-id-column.ts`), which produces a NON-partial index.
     * Ask's `idx_asks_short_id_unique` (mt#2965, migration 0065) still uses
     * that shared helper and stays non-partial — changing the SHARED helper
     * to partial would make drizzle-kit want to re-migrate ask's
     * already-merged index too. Aligning ask (and session, mt#2967) to
     * partial via the shared helper is a cheap follow-up.
     */
    shortId: shortIdColumn(),

    type: memoryTypeEnum("type").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    content: text("content").notNull(),
    scope: memoryScopeEnum("scope").notNull(),
    projectId: text("project_id"),
    tags: text("tags").array().notNull().default([]),
    sourceAgentId: text("source_agent_id"),
    sourceSessionId: text("source_session_id"),
    confidence: real("confidence"),
    supersededBy: uuid("superseded_by"),
    metadata: jsonb("metadata"),
    associations: jsonb("associations").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    accessCount: integer("access_count").default(0).notNull(),
  },
  (table) => [
    // Filtering index: type + scope + projectId is the most common compound filter
    index("idx_memories_type_scope_project").on(table.type, table.scope, table.projectId),
    // Agent lookup index (Phase 2 will write sourceAgentId)
    index("idx_memories_source_agent_id").on(table.sourceAgentId),
    // Lineage traversal index
    index("idx_memories_superseded_by").on(table.supersededBy),
    // GIN index for JSONB containment queries (@>) on associations
    index("idx_memories_associations").using("gin", table.associations),
    // Partial unique index on the mem#N short id (mt#2966/mt#2963, ADR-029,
    // PR #2134 R2) — WHERE short_id IS NOT NULL. See the `shortId` field's
    // doc comment above for the full rationale (partial vs. ask's
    // non-partial shared-helper index, and why).
    uniqueIndex("idx_memories_short_id_unique")
      .on(table.shortId)
      .where(sql`${table.shortId} IS NOT NULL`),
  ]
);

/**
 * Memory embeddings table.
 * Stores pgvector embeddings for semantic search.
 * Follows the project-standard two-table separation used by tasks + rules.
 */
export const memoriesEmbeddingsTable = createEmbeddingsTable({
  tableName: "memories_embeddings",
  idColumn: "memory_id",
  vectorColumn: "vector",
  indexedAtColumn: "indexed_at",
});

// Export configuration for external consumers (e.g., postgres-vector-storage config)
export const MEMORY_EMBEDDINGS_CONFIG = {
  tableName: "memories_embeddings",
  idColumn: "memory_id",
  vectorColumn: "vector",
  indexedAtColumn: "indexed_at",
} as const;

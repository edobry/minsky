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
     * declared below in the index-builder callback) is a PLAIN (non-partial)
     * unique index — matching ask's `idx_asks_short_id_unique` (mt#2965,
     * migration 0065) and the shared `shortIdUniqueIndex()` foundation
     * helper (`short-id-column.ts`). It was briefly declared PARTIAL (`WHERE
     * short_id IS NOT NULL`, PR #2134 R2) on the theory that this documents
     * NULL semantics more explicitly and keeps the index small; this broke
     * in production (mt#3005, 2026-07-21): Postgres only lets `ON CONFLICT`
     * infer a partial index when the conflict target's own `WHERE` clause
     * matches, and the insert code (`memory/memory-service.ts`'s `create`)
     * uses a bare `.onConflictDoNothing({ target: memoriesTable.shortId })`
     * with no predicate — so every memory insert failed with "no unique or
     * exclusion constraint matching the ON CONFLICT specification." A plain
     * unique index has identical NULL semantics for this use case (Postgres
     * NULLS DISTINCT already lets unlimited NULL `short_id` rows coexist),
     * so the partial predicate bought nothing and broke conflict inference.
     * See mt#3005 for the incident; migration 0068 drops and recreates this
     * index as plain.
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
    // Plain (non-partial) unique index on the mem#N short id
    // (mt#2966/mt#2963, ADR-029; fixed to plain in mt#3005). See the
    // `shortId` field's doc comment above for the full rationale (why the
    // earlier partial form broke ON CONFLICT inference in production).
    uniqueIndex("idx_memories_short_id_unique").on(table.shortId),
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

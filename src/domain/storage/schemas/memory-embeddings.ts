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
  uuid,
  jsonb,
} from "drizzle-orm/pg-core";
import { createEmbeddingsTable } from "./embeddings-schema-factory";

// Postgres enums for memory type and scope
export const memoryTypeEnum = pgEnum("memory_type", ["user", "feedback", "project", "reference"]);
export const memoryScopeEnum = pgEnum("memory_scope", ["project", "user", "cross_project"]);

/**
 * Primary memories table.
 * Stores the domain entity (content, metadata, lineage).
 */
export const memoriesTable = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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

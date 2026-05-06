import { pgTable, text, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { vector } from "drizzle-orm/pg-core";

export interface EmbeddingsTableConfig {
  tableName: string;
  idColumn: string;
  vectorColumn: string;
  indexedAtColumn: string;
  dimensions?: number;
  domainColumns?: Record<string, unknown>;
}

/**
 * Create a standardized embeddings table schema
 * This ensures consistency between tasks_embeddings and rules_embeddings
 * Supports optional domain-specific columns for server-side filtering
 */
export function createEmbeddingsTable(config: EmbeddingsTableConfig) {
  const {
    tableName,
    idColumn,
    vectorColumn,
    indexedAtColumn,
    dimensions = 1536,
    domainColumns = {},
  } = config;

  const baseColumns = {
    id: text(idColumn).primaryKey(),
    vector: vector(vectorColumn, { dimensions }),
    metadata: jsonb("metadata"),
    contentHash: text("content_hash"),
    indexedAt: timestamp(indexedAtColumn, { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  };

  // Merge base columns with domain-specific columns
  const allColumns = { ...baseColumns, ...domainColumns };

  return pgTable(tableName, allColumns, (table) => [
    index(`idx_${tableName}_hnsw`).using(
      "hnsw",
      table.vector.asc().nullsLast().op("vector_l2_ops")
    ),
  ]);
}

// Standard configurations for consistency
export const EMBEDDINGS_CONFIGS = {
  tasks: {
    tableName: "tasks_embeddings",
    idColumn: "task_id",
    vectorColumn: "vector",
    indexedAtColumn: "indexed_at",
  },
  rules: {
    tableName: "rules_embeddings",
    idColumn: "rule_id",
    vectorColumn: "vector", // Standardize on "vector" column name
    indexedAtColumn: "indexed_at", // Standardize on "indexed_at" column name
  },
  tools: {
    tableName: "tool_embeddings",
    idColumn: "tool_id",
    vectorColumn: "vector",
    indexedAtColumn: "indexed_at",
  },
  memory: {
    tableName: "memories_embeddings",
    idColumn: "memory_id",
    vectorColumn: "vector",
    indexedAtColumn: "indexed_at",
  },
  // knowledge domain (mt#1605 audit): knowledge_embeddings table exists (migration 0020)
  // and uses document_id as the id column. Knowledge consumers do NOT currently go
  // through getVectorStorageForDomain — they use a separate code path. Adding this
  // entry here ensures correct routing if knowledge is wired through the standard
  // factory in the future. See PR body for full audit finding.
  knowledge: {
    tableName: "knowledge_embeddings",
    idColumn: "document_id",
    vectorColumn: "vector",
    indexedAtColumn: "indexed_at",
  },
} as const;

/**
 * Finite union of vector-storage domains.
 * Each domain maps to a distinct embeddings table via EMBEDDINGS_CONFIGS.
 * Using a union (option b from mt#1605 spec) makes routing type-safe and
 * prevents accidental cross-domain contamination.
 */
export type VectorDomain = keyof typeof EMBEDDINGS_CONFIGS;

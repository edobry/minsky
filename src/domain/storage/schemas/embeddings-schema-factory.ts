import { pgTable, text, integer, timestamp, index, jsonb, PgColumn } from "drizzle-orm/pg-core";
import { vector } from "drizzle-orm/pg-core";

export interface EmbeddingsTableConfig {
  tableName: string;
  idColumn: string;
  vectorColumn: string;
  indexedAtColumn: string;
  dimensions?: number;
  domainColumns?: Record<string, PgColumn>;
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
} as const;

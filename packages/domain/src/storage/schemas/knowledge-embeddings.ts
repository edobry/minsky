import { createEmbeddingsTable } from "./embeddings-schema-factory";

// Knowledge embeddings configuration following standardized patterns
const KNOWLEDGE_EMBEDDINGS_CONFIG = {
  tableName: "knowledge_embeddings",
  idColumn: "document_id",
  vectorColumn: "vector",
  indexedAtColumn: "indexed_at",
  // No domain-specific columns for now - use metadata JSONB for filtering
  // domainColumns: {},
};

// Drizzle schema for knowledge embeddings (vectors only)
// Uses standardized embeddings schema factory for consistency with tasks_embeddings and rules_embeddings
// Uses metadata JSONB for filtering instead of separate domain columns
export const knowledgeEmbeddingsTable = createEmbeddingsTable(KNOWLEDGE_EMBEDDINGS_CONFIG);

// Export configuration for use in services
export { KNOWLEDGE_EMBEDDINGS_CONFIG };

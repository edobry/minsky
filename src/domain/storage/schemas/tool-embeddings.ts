import { createEmbeddingsTable, EMBEDDINGS_CONFIGS } from "./embeddings-schema-factory";
import { text } from "drizzle-orm/pg-core";

// Tool embeddings configuration following standardized patterns
const TOOL_EMBEDDINGS_CONFIG = {
  tableName: "tool_embeddings",
  idColumn: "tool_id",
  vectorColumn: "vector",
  indexedAtColumn: "indexed_at",
  // No domain-specific columns for now - use metadata JSONB for filtering
  // domainColumns: {},
};

// Drizzle schema for tool embeddings (vectors only)
// Uses standardized embeddings schema factory for consistency with tasks_embeddings and rules_embeddings
// Uses metadata JSONB for filtering instead of separate domain columns
export const toolEmbeddingsTable = createEmbeddingsTable(TOOL_EMBEDDINGS_CONFIG);

// Export configuration for use in services
export { TOOL_EMBEDDINGS_CONFIG };

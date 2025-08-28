import { createEmbeddingsTable, EMBEDDINGS_CONFIGS } from "./embeddings-schema-factory";
import { text } from "drizzle-orm/pg-core";

// Tool embeddings configuration following standardized patterns
const TOOL_EMBEDDINGS_CONFIG = {
  tableName: "tool_embeddings",
  idColumn: "tool_id",
  vectorColumn: "vector",
  indexedAtColumn: "indexed_at",
  domainColumns: {
    // Tool-specific columns for server-side filtering
    category: text("category").notNull(), // CommandCategory enum as text
    description: text("description").notNull(),
  },
};

// Drizzle schema for tool embeddings (vectors + denormalized filter columns)
// Uses standardized embeddings schema factory for consistency with tasks_embeddings and rules_embeddings
// Includes denormalized category and description columns for server-side filtering
export const toolEmbeddingsTable = createEmbeddingsTable(TOOL_EMBEDDINGS_CONFIG);

// Export configuration for use in services
export { TOOL_EMBEDDINGS_CONFIG };

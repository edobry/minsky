import { createEmbeddingsTable, EMBEDDINGS_CONFIGS } from "./embeddings-schema-factory";

// Drizzle schema for rules embeddings (vectors only)
// Uses standardized embeddings schema factory for consistency with tasks_embeddings
export const rulesEmbeddingsTable = createEmbeddingsTable(EMBEDDINGS_CONFIGS.rules);

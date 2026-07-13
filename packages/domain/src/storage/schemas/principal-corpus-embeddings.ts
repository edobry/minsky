import { createEmbeddingsTable, EMBEDDINGS_CONFIGS } from "./embeddings-schema-factory";

// Principal-corpus embeddings: stores the principal's personal corpus
// (e.g., Twitter archive originals) for principal-scoped semantic search.
// Tweet IDs are the primary key; created_at, engagement counts, and thread
// membership are carried in the metadata JSONB column (no domain columns
// — the corpus has wide-ranging metadata best modeled as JSONB).
//
// Originating task: mt#1930. Decision context: workshop output in
// `.claude/skills/marketing-site-design/references/minsky-myth-2026-05.md`.
export const principalCorpusEmbeddingsTable = createEmbeddingsTable(
  EMBEDDINGS_CONFIGS["principal-corpus"]
);

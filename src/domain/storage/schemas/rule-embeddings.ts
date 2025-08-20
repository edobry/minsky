import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { vector } from "drizzle-orm/pg-core";

// Drizzle schema for rules embeddings (vectors only)
// Mirrors tasks embeddings with metadata and content hash for staleness detection
export const rulesEmbeddingsTable = pgTable(
  "rules_embeddings",
  {
    ruleId: text("rule_id").primaryKey(),
    dimension: integer("dimension").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }),
    metadata: text("metadata").$type<any>().$defaultFn(() => undefined as any), // JSONB via migrations
    contentHash: text("content_hash"),
    lastIndexedAt: timestamp("last_indexed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index("idx_rules_embeddings_hnsw").using(
      "hnsw",
      table.embedding.asc().nullsLast().op("vector_l2_ops")
    ),
  ]
);



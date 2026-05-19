-- Create principal_corpus_embeddings table for storing principal-scoped corpus
-- embeddings (mt#1930). Tweet ID is the primary key; metadata JSONB carries
-- created_at, engagement counts, thread membership, and original text.
CREATE TABLE IF NOT EXISTS "principal_corpus_embeddings" (
	"tweet_id" text PRIMARY KEY NOT NULL,
	"vector" vector(1536),
	"metadata" jsonb,
	"content_hash" text,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_principal_corpus_embeddings_hnsw" ON "principal_corpus_embeddings" USING hnsw ("vector" vector_l2_ops);

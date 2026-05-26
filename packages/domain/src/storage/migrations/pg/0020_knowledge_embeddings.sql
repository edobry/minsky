-- Create knowledge_embeddings table for storing document embeddings from knowledge sources
CREATE TABLE IF NOT EXISTS "knowledge_embeddings" (
	"document_id" text PRIMARY KEY NOT NULL,
	"vector" vector(1536),
	"metadata" jsonb,
	"content_hash" text,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_knowledge_embeddings_hnsw" ON "knowledge_embeddings" USING hnsw ("vector" vector_l2_ops);

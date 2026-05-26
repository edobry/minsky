CREATE TABLE "rules_embeddings" (
	"rule_id" text PRIMARY KEY NOT NULL,
	"dimension" integer NOT NULL,
	"embedding" vector(1536),
	"metadata" jsonb,
	"content_hash" text,
	"last_indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "idx_rules_embeddings_hnsw" ON "rules_embeddings" USING hnsw ("embedding" vector_l2_ops);
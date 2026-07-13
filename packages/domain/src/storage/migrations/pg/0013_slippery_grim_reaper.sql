ALTER TABLE "rules_embeddings" RENAME COLUMN "embedding" TO "vector";--> statement-breakpoint
ALTER TABLE "rules_embeddings" RENAME COLUMN "last_indexed_at" TO "indexed_at";--> statement-breakpoint
DROP INDEX "idx_rules_embeddings_hnsw";--> statement-breakpoint
ALTER TABLE "tasks_embeddings" ALTER COLUMN "metadata" SET DATA TYPE jsonb USING "metadata"::jsonb;--> statement-breakpoint
ALTER TABLE "tasks_embeddings" ALTER COLUMN "content_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks_embeddings" ADD COLUMN "created_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "tasks_embeddings" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
CREATE INDEX "idx_rules_embeddings_hnsw" ON "rules_embeddings" USING hnsw ("vector" vector_l2_ops);--> statement-breakpoint
ALTER TABLE "rules_embeddings" DROP COLUMN "dimension";
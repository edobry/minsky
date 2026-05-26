CREATE TABLE "tasks_embeddings" (
	"task_id" text PRIMARY KEY NOT NULL,
	"dimension" integer NOT NULL,
	"embedding" vector(1536),
	"last_indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "idx_tasks_embeddings_hnsw" ON "tasks_embeddings" USING hnsw ("embedding" vector_l2_ops);
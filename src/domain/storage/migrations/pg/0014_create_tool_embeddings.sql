CREATE TABLE "tool_embeddings" (
	"tool_id" text PRIMARY KEY NOT NULL,
	"vector" vector(1536),
	"metadata" jsonb,
	"content_hash" text,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"category" text NOT NULL,
	"description" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_tool_embeddings_hnsw" ON "tool_embeddings" USING hnsw ("vector" vector_l2_ops);
--> statement-breakpoint
CREATE INDEX "idx_tool_embeddings_category" ON "tool_embeddings" ("category");
--> statement-breakpoint
CREATE INDEX "idx_tool_embeddings_description" ON "tool_embeddings" ("description");

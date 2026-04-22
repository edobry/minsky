-- Memory Phase 1: memories + memories_embeddings tables
-- Two-table design: domain data separate from embeddings (consistent with tasks + rules pattern).
-- HNSW index used for memories_embeddings (project-wide standard, not ivfflat/cosine).

-- Enum types
CREATE TYPE "public"."memory_type" AS ENUM ('user', 'feedback', 'project', 'reference');
--> statement-breakpoint
CREATE TYPE "public"."memory_scope" AS ENUM ('project', 'user', 'cross_project');
--> statement-breakpoint

-- Primary memories table
CREATE TABLE IF NOT EXISTS "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" memory_type NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"content" text NOT NULL,
	"scope" memory_scope NOT NULL,
	"project_id" text,
	"tags" text[] NOT NULL DEFAULT '{}',
	"source_agent_id" text,
	"source_session_id" text,
	"confidence" real,
	"superseded_by" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"access_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint

-- Self-referential FK for lineage (nullable — not set until superseded)
ALTER TABLE "memories" ADD CONSTRAINT "memories_superseded_by_memories_id_fk"
	FOREIGN KEY ("superseded_by") REFERENCES "memories"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- BTree indexes on memories table
CREATE INDEX IF NOT EXISTS "idx_memories_type_scope_project" ON "memories" ("type", "scope", "project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memories_source_agent_id" ON "memories" ("source_agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memories_superseded_by" ON "memories" ("superseded_by");
--> statement-breakpoint

-- Embeddings table (vector storage only)
CREATE TABLE IF NOT EXISTS "memories_embeddings" (
	"memory_id" text PRIMARY KEY NOT NULL,
	"vector" vector(1536),
	"metadata" jsonb,
	"content_hash" text,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint

-- HNSW index for vector similarity search (project-wide standard)
CREATE INDEX IF NOT EXISTS "idx_memories_embeddings_hnsw" ON "memories_embeddings" USING hnsw ("vector" vector_l2_ops);

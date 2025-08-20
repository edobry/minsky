-- Create task_specs table for 3-table design
CREATE TABLE "task_specs" (
  "task_id" TEXT PRIMARY KEY,
  "content" TEXT NOT NULL,
  "content_hash" TEXT,
  "version" INTEGER DEFAULT 1,
  "created_at" TIMESTAMPTZ DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ DEFAULT NOW(),
  FOREIGN KEY ("task_id") REFERENCES "tasks" ("id") ON DELETE CASCADE
);

-- Migrate existing spec data from tasks table to task_specs table
INSERT INTO "task_specs" ("task_id", "content", "content_hash", "created_at", "updated_at")
SELECT "id", "spec", "content_hash", "created_at", "updated_at" 
FROM "tasks" 
WHERE "spec" IS NOT NULL;

-- Drop the spec column from tasks table
ALTER TABLE "tasks" DROP COLUMN "spec";

-- Update tasks_embeddings table structure
-- Add foreign key constraint and clean up columns
ALTER TABLE "tasks_embeddings" ADD CONSTRAINT "tasks_embeddings_task_id_fkey" 
  FOREIGN KEY ("task_id") REFERENCES "tasks" ("id") ON DELETE CASCADE;

-- Rename embedding column to vector for consistency
ALTER TABLE "tasks_embeddings" RENAME COLUMN "embedding" TO "vector";

-- Drop dimension column (not needed with fixed dimensions)
ALTER TABLE "tasks_embeddings" DROP COLUMN "dimension";

-- Rename last_indexed_at to indexed_at
ALTER TABLE "tasks_embeddings" RENAME COLUMN "last_indexed_at" TO "indexed_at";

-- Drop created_at and updated_at from embeddings (not needed)
ALTER TABLE "tasks_embeddings" DROP COLUMN "created_at";
ALTER TABLE "tasks_embeddings" DROP COLUMN "updated_at";

-- Add content_hash column to track when embeddings need regeneration
ALTER TABLE "tasks_embeddings" ADD COLUMN "content_hash" TEXT;
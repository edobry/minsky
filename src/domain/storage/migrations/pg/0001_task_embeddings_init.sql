-- Enable pgvector extension if not already present
CREATE EXTENSION IF NOT EXISTS vector;

-- Create task_embeddings table if it does not exist
CREATE TABLE IF NOT EXISTS task_embeddings (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  dimension INT NOT NULL,
  embedding vector(1536), -- dimension will be validated in app layer
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Optional: IVFFlat index if supported (requires appropriate setup)
DO $$
BEGIN
  BEGIN
    CREATE INDEX IF NOT EXISTS idx_task_embeddings_ivf
      ON task_embeddings USING ivfflat (embedding vector_l2_ops);
  EXCEPTION WHEN OTHERS THEN
    -- ignore if index type not available
    NULL;
  END;
END$$;

-- For existing deployments that had 'qualified_task_id', rename to 'task_id' if present
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'task_embeddings' AND column_name = 'qualified_task_id'
  ) THEN
    ALTER TABLE task_embeddings RENAME COLUMN qualified_task_id TO task_id;
  END IF;
END $$;

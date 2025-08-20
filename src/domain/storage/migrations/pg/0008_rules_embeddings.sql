-- Create rules_embeddings table mirroring tasks embeddings pattern
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS public.rules_embeddings (
  rule_id TEXT PRIMARY KEY,
  dimension INT NOT NULL,
  embedding VECTOR(1536),
  metadata JSONB,
  content_hash TEXT,
  last_indexed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create HNSW index for L2 distance (consistent with tasks)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'idx_rules_embeddings_hnsw' AND n.nspname = 'public'
  ) THEN
    EXECUTE 'CREATE INDEX idx_rules_embeddings_hnsw ON public.rules_embeddings USING hnsw (embedding vector_l2_ops)';
  END IF;
END$$;

-- Add columns if table pre-existed without them
ALTER TABLE public.rules_embeddings
  ADD COLUMN IF NOT EXISTS metadata JSONB,
  ADD COLUMN IF NOT EXISTS content_hash TEXT,
  ADD COLUMN IF NOT EXISTS last_indexed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- No-op drop: the IVFFlat index was never created on this environment
-- Keeping only the HNSW creation in this migration
CREATE INDEX IF NOT EXISTS "idx_tasks_hnsw" ON "tasks" USING hnsw ("embedding" vector_l2_ops);

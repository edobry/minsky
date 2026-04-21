-- Add session liveness tracking fields to sessions table
-- Foundation for session activity monitoring and health assessment
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_activity_at TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_commit_hash TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_commit_message TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS commit_count INTEGER;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_id TEXT;

-- Backfill: set existing sessions to CREATED with lastActivityAt = createdAt
UPDATE sessions SET status = 'CREATED', last_activity_at = created_at::text WHERE status IS NULL;

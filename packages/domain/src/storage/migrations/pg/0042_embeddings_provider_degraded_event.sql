-- Add embeddings.provider_degraded event type — mt#2147
--
-- Extends the system_event_type enum with a new value for embeddings
-- subsystem degradation events (quota exhaustion, repeated 429s).
--
-- Backout:
--   -- PG enums don't support DROP VALUE; would need to recreate the type.
--   -- In practice, an unused enum value is harmless.

ALTER TYPE "system_event_type" ADD VALUE IF NOT EXISTS 'embeddings.provider_degraded';

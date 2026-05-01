-- Add service-window fields to asks table — mt#1411 spine (mt#1488).
--
-- Four new nullable columns supporting the service-window primitive:
--   service_strategy: routing strategy — 'asap' | 'scheduled' | 'deadline-bound'
--   window_key:       named window the Ask targets (e.g. 'ask-hours')
--   window_missed_count: how many scheduled windows this Ask has missed (starts 0)
--   force_immediate:  bypass the window check when true
--
-- Index: asks_window_idx for window-keyed queries (router + reaper in mt#1490).
-- Backfill: all existing rows get service_strategy='asap' — preserves today's behavior.
--
-- Backout:
--   DROP INDEX IF EXISTS asks_window_idx;
--   ALTER TABLE asks
--     DROP COLUMN IF EXISTS service_strategy,
--     DROP COLUMN IF EXISTS window_key,
--     DROP COLUMN IF EXISTS window_missed_count,
--     DROP COLUMN IF EXISTS force_immediate;

ALTER TABLE "asks"
  ADD COLUMN IF NOT EXISTS "service_strategy" text,
  ADD COLUMN IF NOT EXISTS "window_key" text,
  ADD COLUMN IF NOT EXISTS "window_missed_count" integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "force_immediate" boolean DEFAULT false;
--> statement-breakpoint

-- Partial index for window-keyed router/reaper queries (mt#1490).
CREATE INDEX IF NOT EXISTS "asks_window_idx"
  ON "asks" ("window_key")
  WHERE "window_key" IS NOT NULL;
--> statement-breakpoint

-- Backfill: existing rows get service_strategy='asap', preserving current behavior.
UPDATE "asks" SET "service_strategy" = 'asap' WHERE "service_strategy" IS NULL;

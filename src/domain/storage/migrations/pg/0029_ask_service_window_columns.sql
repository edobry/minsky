-- Add service-window fields to asks table — mt#1411 spine (mt#1488).
--
-- Four new nullable columns supporting the service-window primitive:
--   service_strategy: routing strategy — 'asap' | 'scheduled' | 'deadline-bound'
--   window_key:       named window the Ask targets (e.g. 'ask-hours')
--   window_missed_count: how many scheduled windows this Ask has missed (starts 0)
--   force_immediate:  bypass the window check when true
--
-- Index: asks_window_idx (partial) for window-keyed queries (router + reaper in mt#1490).
-- CHECK constraints: service_strategy enum guard + window_key/strategy coherence guard.
-- Backfill: all existing rows get service_strategy='asap' — preserves today's behavior.
--   The backfill runs BEFORE the CHECK constraint is added so it cannot violate it.
--
-- Backout:
--   ALTER TABLE asks DROP CONSTRAINT IF EXISTS chk_asks_service_strategy;
--   ALTER TABLE asks DROP CONSTRAINT IF EXISTS chk_asks_window_key_strategy;
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
-- Must run BEFORE CHECK constraints so NULL rows don't violate the enum guard.
UPDATE "asks" SET "service_strategy" = 'asap' WHERE "service_strategy" IS NULL;
--> statement-breakpoint

-- Backfill: existing rows get default values for window_missed_count and force_immediate.
-- Belt-and-suspenders with toAsk() defaults: data is consistent AND code defends against NULLs.
-- PostgreSQL ADD COLUMN DEFAULT does not backfill pre-existing rows, so explicit UPDATE is required.
UPDATE "asks" SET "window_missed_count" = 0 WHERE "window_missed_count" IS NULL;
UPDATE "asks" SET "force_immediate" = false WHERE "force_immediate" IS NULL;
--> statement-breakpoint

-- CHECK: enum guard — reject unknown service_strategy values at DB level.
-- NULL is allowed (treated as 'asap' by the router).
ALTER TABLE "asks"
  ADD CONSTRAINT "chk_asks_service_strategy"
  CHECK (service_strategy IS NULL OR service_strategy IN ('asap', 'scheduled', 'deadline-bound'));
--> statement-breakpoint

-- CHECK: coherence guard — window_key only makes sense for scheduled asks.
-- Prevents corrupt rows where window_key is set but strategy is asap/deadline-bound.
ALTER TABLE "asks"
  ADD CONSTRAINT "chk_asks_window_key_strategy"
  CHECK (window_key IS NULL OR service_strategy = 'scheduled');

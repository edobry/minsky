-- Add mem#N short id column (mt#2966, ADR-029) — nullable, no backfill here.
-- See memory-embeddings.ts's `shortId` field doc comment for the full
-- rationale.
--
-- Index: idx_memories_short_id_unique (PARTIAL — WHERE short_id IS NOT NULL).
-- Hand-written here rather than expressed via Drizzle's `uniqueIndex()`
-- builder, because Drizzle ORM cannot express partial index predicates —
-- mirrors ask-schema.ts's `asks_window_idx` precedent
-- (0029_ask_service_window_columns.sql). PARTIAL for explicit NULL
-- semantics + planner clarity (PR #2134 R1): in Postgres, a unique index
-- normally already treats NULLs as distinct (never equal to each other),
-- so an all-NULL `short_id` column during the pre-backfill window is safe
-- either way — the WHERE clause just makes that intent explicit rather
-- than relying on implicit NULL-distinctness, and keeps the index small
-- (btree entries only for backfilled/minted rows).
--
-- ask's `idx_asks_short_id_unique` (mt#2965, migration 0065) is still
-- NON-partial via the shared `shortIdUniqueIndex` helper
-- (short-id-column.ts) — changing that SHARED helper to partial would make
-- drizzle-kit want to re-migrate ask's already-merged index too, so this
-- migration only makes memory's index partial and leaves the
-- helper/ask untouched. Aligning ask (and session, mt#2967) to partial is a
-- cheap follow-up.
--
-- Backout: DROP INDEX IF EXISTS idx_memories_short_id_unique;
--          ALTER TABLE memories DROP COLUMN IF EXISTS short_id;

ALTER TABLE "memories" ADD COLUMN "short_id" text;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_memories_short_id_unique"
  ON "memories" ("short_id")
  WHERE "short_id" IS NOT NULL;
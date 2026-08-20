CREATE TABLE "guard_event_fire_log_rollup" (
	"guard_name" text PRIMARY KEY NOT NULL,
	"total_fires" integer DEFAULT 0 NOT NULL,
	"first_fire_at" timestamp with time zone,
	"last_fire_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Backfill from the existing corpus (mt#4294).
--
-- Required, not an optimization: `fetchFireLogLifetime` reads this table
-- instead of aggregating `guard_events`, so an empty rollup renders an empty
-- interceptor population rather than an obviously-broken page — the catalog
-- would show zero guards and read as a quiet system.
--
-- This runs the expensive full `GROUP BY` exactly once, here, at ~2.2s over
-- 724,780 rows. That is the cost this task exists to stop paying every five
-- minutes per cockpit; paying it a single time at migration is the point.
--
-- Idempotent via ON CONFLICT so a re-run (or a rebuild landing first)
-- reconciles rather than duplicates.
--
-- Ordering note: ingest maintains this table incrementally from the moment the
-- table exists, so a row appended between this statement's snapshot and its
-- commit could be folded by ingest AND counted here. That is harmless because
-- the ON CONFLICT clause SETS from the recompute rather than adding to what is
-- there — the last writer converges on the corpus rather than double-counting.
-- `rebuildFireLogLifetimeRollup` is the same statement, available for self-heal
-- if a deploy-time interleaving ever does go wrong.
INSERT INTO "guard_event_fire_log_rollup" ("guard_name", "total_fires", "first_fire_at", "last_fire_at", "updated_at")
SELECT
	"guard_name",
	count(*)::int,
	min("occurred_at"),
	max("occurred_at"),
	now()
FROM "guard_events"
WHERE "stream" = 'fire-log' AND "guard_name" IS NOT NULL
GROUP BY "guard_name"
ON CONFLICT ("guard_name") DO UPDATE SET
	"total_fires" = excluded."total_fires",
	"first_fire_at" = excluded."first_fire_at",
	"last_fire_at" = excluded."last_fire_at",
	"updated_at" = now();

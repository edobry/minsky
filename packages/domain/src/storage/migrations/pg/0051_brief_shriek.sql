-- Additive migration for the mt#2537 informational event types (plant board
-- v2.1 — hard cross-process bridges): changeset.created, hook.fired,
-- mcp.disconnect, retrospective.fired, deploy.build, deploy.smoke,
-- deploy.live, deploy.fail. ALTER TYPE ADD VALUE only — mirrors 0042/0045/0049.
--
-- NOTE: `bun run db:generate:pg` also proposed re-creating the `presence_claims`
-- table here. That table was already added by the hand-written migration
-- 0050_presence_claims.sql, which has no corresponding meta/0050_snapshot.json
-- (it wasn't generated via drizzle-kit), so drizzle-kit's diff against the last
-- known snapshot (0049) re-proposed it. That block was removed from this file
-- to keep this migration purely additive for the enum change; 0051_snapshot.json
-- retains the full corrected schema state (presence_claims + these enum values)
-- so future `db:generate:pg` runs diff correctly from here on.
ALTER TYPE "public"."system_event_type" ADD VALUE 'changeset.created';--> statement-breakpoint
ALTER TYPE "public"."system_event_type" ADD VALUE 'hook.fired';--> statement-breakpoint
ALTER TYPE "public"."system_event_type" ADD VALUE 'mcp.disconnect';--> statement-breakpoint
ALTER TYPE "public"."system_event_type" ADD VALUE 'retrospective.fired';--> statement-breakpoint
ALTER TYPE "public"."system_event_type" ADD VALUE 'deploy.build';--> statement-breakpoint
ALTER TYPE "public"."system_event_type" ADD VALUE 'deploy.smoke';--> statement-breakpoint
ALTER TYPE "public"."system_event_type" ADD VALUE 'deploy.live';--> statement-breakpoint
ALTER TYPE "public"."system_event_type" ADD VALUE 'deploy.fail';

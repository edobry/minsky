-- Every statement in this file is guarded so a partial-apply retry re-executes it
-- safely (migration 0068 / PR #2142 / 065fc729f). The backfill below is naturally
-- idempotent: it recomputes the same key from the same source rows.
ALTER TABLE "agent_spawns" DROP CONSTRAINT IF EXISTS "agent_spawns_parent_agent_session_id_parent_turn_index_pk";--> statement-breakpoint
ALTER TABLE "agent_spawns" ADD COLUMN IF NOT EXISTS "parent_tool_use_id" text;--> statement-breakpoint
-- mt#3692 backfill: adopt the harness-assigned Agent tool_use id as this table's
-- natural key for every row whose parent turn still carries a matching Agent call.
--
-- Hand-added to the drizzle-kit output per `migration-authoring.mdc` ("Some
-- migrations need DDL that drizzle-kit can't express … data backfill mixed with
-- DDL"): generate first, then edit — the journal entry and snapshot already exist.
--
-- DISTINCT ON dedupes deliberately. Turn extraction upserts but never deletes, so a
-- re-derivation that shifts turn indices leaves the older rows behind, and both can
-- resolve to the same Agent call. Measured against prod 2026-08-04: 2,444 of 2,623
-- rows match a live spawn-boundary turn, collapsing to 2,333 distinct
-- (session, tool_use_id) keys. The lowest turn index wins; the 111 duplicate rows and
-- the 179 that match no live turn keep NULL. NULLs do not collide under the unique
-- index below, and a NULL row resolves no join, so it renders nothing — which is the
-- specified behavior for a stale row, not a silent failure.
UPDATE "agent_spawns" AS sp
   SET "parent_tool_use_id" = pick."tool_use_id"
  FROM (
    SELECT DISTINCT ON (tt."agent_session_id", call."tool_use_id")
           tt."agent_session_id",
           tt."turn_index",
           call."tool_use_id"
      FROM "agent_transcript_turns" AS tt
      CROSS JOIN LATERAL (
        SELECT block->>'id' AS "tool_use_id"
          FROM jsonb_array_elements(tt."tool_calls") WITH ORDINALITY AS e(block, ord)
         WHERE block->>'type' = 'tool_use'
           AND block->>'name' = 'Agent'
           AND block->>'id' IS NOT NULL
         ORDER BY e.ord
         LIMIT 1
      ) AS call
     WHERE tt."is_spawn_boundary"
       AND jsonb_typeof(tt."tool_calls") = 'array'
     ORDER BY tt."agent_session_id", call."tool_use_id", tt."turn_index"
  ) AS pick
 WHERE sp."parent_agent_session_id" = pick."agent_session_id"
   AND sp."parent_turn_index" = pick."turn_index";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_agent_spawns_parent_tool_use_id" ON "agent_spawns" USING btree ("parent_agent_session_id","parent_tool_use_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_spawns_parent_turn" ON "agent_spawns" USING btree ("parent_agent_session_id","parent_turn_index");
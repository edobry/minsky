-- mt#3708: finish the primary-key drop that migration 0088 only appeared to perform.
--
-- 0088 issued:
--   ALTER TABLE "agent_spawns"
--     DROP CONSTRAINT IF EXISTS "agent_spawns_parent_agent_session_id_parent_turn_index_pk";
--
-- That is the name drizzle-kit derives from its OWN snapshot model. The constraint
-- Postgres actually held was `agent_spawns_pkey` — the server-assigned default, because
-- the table's primary key was created inline rather than by the drizzle model that later
-- described it. The names differ, so `IF EXISTS` matched nothing and the statement
-- succeeded while changing nothing. Verified against prod 2026-08-04T21:58Z, after 0088
-- applied: `agent_spawns_pkey PRIMARY KEY (parent_agent_session_id, parent_turn_index)`
-- was still present.
--
-- Consequence: the surviving key still admits one row per (session, turn_index), so
-- mt#3692's per-Agent-call rows could not be written for the 85 turns that dispatch more
-- than one subagent. The insert violated the key, the pipeline's per-call catch swallowed
-- it, and the badge stayed static — indistinguishable from an ordinary unresolved spawn.
--
-- This drops the key by DISCOVERING its name instead of assuming one, so it works both
-- against prod (`agent_spawns_pkey`) and against a database built from scratch by these
-- migrations, where drizzle assigns its own `..._pk` name. `cold-start-migrate` exercises
-- only the latter, which is exactly why it could not have caught the original defect.
--
-- Idempotent: re-running finds no primary key and does nothing.
DO $$
DECLARE
  pk_name text;
BEGIN
  SELECT c.conname
    INTO pk_name
    FROM pg_constraint c
   WHERE c.conrelid = 'public.agent_spawns'::regclass
     AND c.contype = 'p';

  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.agent_spawns DROP CONSTRAINT %I', pk_name);
    RAISE NOTICE 'mt#3708: dropped agent_spawns primary key %', pk_name;
  ELSE
    RAISE NOTICE 'mt#3708: agent_spawns already has no primary key; nothing to drop';
  END IF;
END $$;
--> statement-breakpoint
-- Fail closed. The whole point of this migration is that a constraint drop can report
-- success while changing nothing, so it must not repeat that pattern: assert the intended
-- end state rather than trusting the statement above. Also re-asserts the unique index the
-- table now depends on for identity, so a future migration that drops the key without
-- providing a replacement cannot pass silently either.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.agent_spawns'::regclass AND contype = 'p'
  ) THEN
    RAISE EXCEPTION 'mt#3708: agent_spawns still has a primary key after the drop';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'agent_spawns'
       AND indexname = 'idx_agent_spawns_parent_tool_use_id'
  ) THEN
    RAISE EXCEPTION 'mt#3708: idx_agent_spawns_parent_tool_use_id is missing; agent_spawns would have no identity';
  END IF;
END $$;

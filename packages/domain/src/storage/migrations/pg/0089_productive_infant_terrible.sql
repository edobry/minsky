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
-- This drops the key by DISCOVERING its name instead of assuming one, so it cannot be
-- defeated by a name mismatch in any environment.
--
-- Note what is NOT true, since an earlier draft of this comment said otherwise: a
-- cold-start database does NOT get drizzle's `..._pk` name. Migration 0027 creates the
-- table with an inline unnamed PRIMARY KEY, so Postgres assigns `agent_spawns_pkey`
-- everywhere — prod and fresh builds alike. `cold-start-migrate` went green for exactly
-- the same reason prod did: a no-op `DROP CONSTRAINT IF EXISTS` does not error. No
-- environment difference was involved, and no amount of CI could have caught this class
-- without asserting the end state, which is what the block below now does.
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
-- end state rather than trusting the statement above.
--
-- Both checks assert PROPERTIES, never names (PR #2638 R1). Asserting that an index
-- called `idx_agent_spawns_parent_tool_use_id` exists would repeat the original defect's
-- own mistake one level up: a name is a proxy, and the property that actually matters is
-- "some UNIQUE index covers exactly (parent_agent_session_id, parent_tool_use_id), in
-- that order". A renamed-but-correct index must pass; a same-named index that lost its
-- uniqueness, gained a column, or reordered its columns must fail, because the table's
-- row identity — and the pipeline's ON CONFLICT target — depends on that exact shape.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.agent_spawns'::regclass AND contype = 'p'
  ) THEN
    RAISE EXCEPTION 'mt#3708: agent_spawns still has a primary key after the drop';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
     WHERE i.indrelid = 'public.agent_spawns'::regclass
       AND i.indisunique
       AND i.indpred IS NULL          -- a PARTIAL unique index cannot serve as an
                                      -- ON CONFLICT arbiter for a bare column target
                                      -- (the mt#3005 / mem#659 failure mode)
       AND (
         SELECT array_agg(a.attname::text ORDER BY k.ord)
           FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a
             ON a.attrelid = i.indrelid AND a.attnum = k.attnum
       ) = ARRAY['parent_agent_session_id', 'parent_tool_use_id']
  ) THEN
    RAISE EXCEPTION
      'mt#3708: agent_spawns has no non-partial UNIQUE index on exactly (parent_agent_session_id, parent_tool_use_id) — the table would have no usable row identity';
  END IF;
END $$;

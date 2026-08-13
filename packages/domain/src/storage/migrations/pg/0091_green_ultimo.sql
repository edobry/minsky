ALTER TABLE "subagent_invocations" ADD COLUMN IF NOT EXISTS "parent_agent_session_id" text;--> statement-breakpoint
ALTER TABLE "subagent_invocations" ADD COLUMN IF NOT EXISTS "parent_tool_use_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_subagent_invocations_parent_tool_use_id" ON "subagent_invocations" USING btree ("parent_agent_session_id","parent_tool_use_id");--> statement-breakpoint
-- Assert the END STATE rather than trusting the statements' exit status
-- (`migration-authoring.mdc`): an `IF NOT EXISTS` index creation succeeds and
-- changes nothing when an index of that NAME already exists, whatever its shape.
-- So verify the SHAPE the writers depend on — unique, non-partial, exactly these
-- two columns in this order — and never the name, which is the proxy that guard
-- exists to stop people trusting.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indrelid = 'public.subagent_invocations'::regclass
       AND i.indisunique
       AND i.indpred IS NULL
       AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
              FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
           = ARRAY['parent_agent_session_id', 'parent_tool_use_id']
  ) THEN
    RAISE EXCEPTION 'subagent_invocations has no unique (parent_agent_session_id, parent_tool_use_id) index';
  END IF;
END $$;

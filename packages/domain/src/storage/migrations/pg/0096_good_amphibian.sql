CREATE TABLE "cockpit_conversation_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"conversation_id" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_accessed_at" timestamp with time zone,
	CONSTRAINT "cockpit_conversation_shares_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE INDEX "idx_conversation_shares_token_hash" ON "cockpit_conversation_shares" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_conversation_shares_conversation" ON "cockpit_conversation_shares" USING btree ("conversation_id");--> statement-breakpoint
-- mt#4024: same narrow grant as 0094 (mt#4023). The deployed cockpit-preview
-- service connects as the SELECT-only `minsky_preview` role, so it cannot mint
-- or revoke a share without write access to this one table. The table holds no
-- product data — a token hash, a conversation id, and timestamps — so this
-- widens no access to anything the role could not already read.
--
-- Guarded on the role's existence: local and CI databases have no
-- `minsky_preview`, and an unguarded GRANT would fail the migration there.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'minsky_preview') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "cockpit_conversation_shares" TO minsky_preview;
  END IF;
END
$$;
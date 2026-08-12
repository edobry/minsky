CREATE TABLE "cockpit_auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"passkey_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cockpit_auth_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "cockpit_passkeys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"transports" jsonb,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "cockpit_passkeys_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
ALTER TABLE "cockpit_auth_sessions" ADD CONSTRAINT "cockpit_auth_sessions_passkey_id_cockpit_passkeys_id_fk" FOREIGN KEY ("passkey_id") REFERENCES "public"."cockpit_passkeys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_cockpit_auth_sessions_token_hash" ON "cockpit_auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_cockpit_auth_sessions_expires_at" ON "cockpit_auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_cockpit_passkeys_credential_id" ON "cockpit_passkeys" USING btree ("credential_id");--> statement-breakpoint
-- mt#4023: the deployed cockpit-preview service connects as the SELECT-only
-- `minsky_preview` role (verified 2026-08-11 via pg_stat_activity). It cannot
-- authenticate anyone without write access to its own auth tables, so grant it
-- exactly these two and nothing else. Both hold authentication material only —
-- no product data — so this widens no access to anything the role could not
-- already read.
--
-- Guarded on the role's existence: local and CI databases have no
-- `minsky_preview`, and an unguarded GRANT would fail the migration there.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'minsky_preview') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "cockpit_passkeys" TO minsky_preview;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "cockpit_auth_sessions" TO minsky_preview;
  END IF;
END
$$;
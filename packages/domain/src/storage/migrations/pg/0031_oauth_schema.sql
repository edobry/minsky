-- OAuth token-store schema — mt#1662
--
-- Adds four tables for the InProcessOAuthProvider Postgres adapter (mt#1663):
--
--   oauth_clients              — DCR-registered clients (RFC 7591)
--   oauth_authorization_codes  — PKCE authorization codes (RFC 7636)
--   oauth_access_tokens        — issued access tokens with revocation
--   oauth_refresh_tokens       — refresh tokens with rotation chain
--
-- All secret/token values stored as SHA-256 hash (columns ending in _hash).
-- Raw tokens/secrets are never written to the database.
--
-- Backout:
--   DROP INDEX IF EXISTS idx_oauth_refresh_tokens_client_sub;
--   DROP INDEX IF EXISTS idx_oauth_refresh_tokens_expires_at;
--   DROP INDEX IF EXISTS idx_oauth_access_tokens_client_sub;
--   DROP INDEX IF EXISTS idx_oauth_access_tokens_expires_at;
--   DROP INDEX IF EXISTS idx_oauth_auth_codes_client_sub;
--   DROP INDEX IF EXISTS idx_oauth_auth_codes_expires_at;
--   DROP INDEX IF EXISTS idx_oauth_clients_name;
--   DROP TABLE IF EXISTS oauth_refresh_tokens;
--   DROP TABLE IF EXISTS oauth_access_tokens;
--   DROP TABLE IF EXISTS oauth_authorization_codes;
--   DROP TABLE IF EXISTS oauth_clients;

-- ---------------------------------------------------------------------------
-- oauth_clients
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "oauth_clients" (
  "client_id"                       text PRIMARY KEY NOT NULL,
  "client_secret_hash"              text,
  "client_name"                     text,
  "redirect_uris"                   text NOT NULL,
  "grant_types"                     text NOT NULL,
  "token_endpoint_auth_method"      text NOT NULL,
  "registration_access_token_hash"  text,
  "created_at"                      timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_oauth_clients_name"
  ON "oauth_clients" ("client_name");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- oauth_authorization_codes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "oauth_authorization_codes" (
  "code_hash"             text PRIMARY KEY NOT NULL,
  "client_id"             text NOT NULL,
  "sub"                   text NOT NULL,
  "redirect_uri"          text NOT NULL,
  "scopes"                text NOT NULL,
  "audience"              text,
  "code_challenge"        text,
  "code_challenge_method" text,
  "expires_at"            timestamp with time zone NOT NULL,
  "consumed_at"           timestamp with time zone,
  CONSTRAINT "fk_auth_codes_client_id"
    FOREIGN KEY ("client_id") REFERENCES "oauth_clients" ("client_id")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_oauth_auth_codes_expires_at"
  ON "oauth_authorization_codes" ("expires_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_oauth_auth_codes_client_sub"
  ON "oauth_authorization_codes" ("client_id", "sub");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- oauth_access_tokens
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "oauth_access_tokens" (
  "token_hash"  text PRIMARY KEY NOT NULL,
  "client_id"   text NOT NULL,
  "sub"         text NOT NULL,
  "scopes"      text NOT NULL,
  "audience"    text,
  "expires_at"  timestamp with time zone NOT NULL,
  "revoked_at"  timestamp with time zone,
  CONSTRAINT "fk_access_tokens_client_id"
    FOREIGN KEY ("client_id") REFERENCES "oauth_clients" ("client_id")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_oauth_access_tokens_expires_at"
  ON "oauth_access_tokens" ("expires_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_oauth_access_tokens_client_sub"
  ON "oauth_access_tokens" ("client_id", "sub");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- oauth_refresh_tokens
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "oauth_refresh_tokens" (
  "token_hash"       text PRIMARY KEY NOT NULL,
  "client_id"        text NOT NULL,
  "sub"              text NOT NULL,
  "scopes"           text NOT NULL,
  "audience"         text,
  "expires_at"       timestamp with time zone NOT NULL,
  "revoked_at"       timestamp with time zone,
  "replaced_by_hash" text,
  CONSTRAINT "fk_refresh_tokens_client_id"
    FOREIGN KEY ("client_id") REFERENCES "oauth_clients" ("client_id")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_oauth_refresh_tokens_expires_at"
  ON "oauth_refresh_tokens" ("expires_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_oauth_refresh_tokens_client_sub"
  ON "oauth_refresh_tokens" ("client_id", "sub");

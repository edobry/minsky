-- Create a read-only Supabase database role for cockpit preview deploys (mt#2096).
--
-- Run this once against the production Supabase database. The role can SELECT
-- from all tables but cannot INSERT, UPDATE, DELETE, or execute DDL.
--
-- Usage:
--   psql $MINSKY_PERSISTENCE_POSTGRES_URL -f scripts/supabase-preview-role.sql
--
-- After creating the role, construct the connection string:
--   Format: postgres protocol, user=minsky_preview, password from above, host+port+db from Supabase
-- and add it to ~/.config/minsky/railway-secrets.json as:
--   "MINSKY_COCKPIT_PREVIEW_POSTGRES_URL": "<connection-string>"

-- Create the role (idempotent — skips if it already exists)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'minsky_preview') THEN
    CREATE ROLE minsky_preview WITH LOGIN PASSWORD 'CHANGE_ME_BEFORE_RUNNING' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Grant read-only access to all existing tables in the public schema
GRANT USAGE ON SCHEMA public TO minsky_preview;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO minsky_preview;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO minsky_preview;

-- Ensure future tables also get SELECT grants
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO minsky_preview;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO minsky_preview;

-- Also grant on the drizzle schema if it exists (used by drizzle-kit migrations)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_namespace WHERE nspname = 'drizzle') THEN
    GRANT USAGE ON SCHEMA drizzle TO minsky_preview;
    GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO minsky_preview;
    ALTER DEFAULT PRIVILEGES IN SCHEMA drizzle GRANT SELECT ON TABLES TO minsky_preview;
  END IF;
END
$$;
-- Create the DML-only runtime Supabase role for Minsky app binaries (mt#2542).
--
-- Least-privilege split (defense-in-depth for the mt#2505 migration decouple):
--   - minsky_app   (THIS script) — SELECT/INSERT/UPDATE/DELETE only. The role every
--     app binary connects with: hosted MCP, reviewer, cockpit daemon, local MCP,
--     CLI, sessions. Cannot CREATE/ALTER/DROP anything.
--   - postgres     — the DDL-capable migration credential. Used ONLY by the
--     deploy-keyed migrator (.github/workflows/deploy-minsky-mcp.yml migrate step,
--     via the MINSKY_PERSISTENCE_POSTGRES_URL GitHub Actions secret) and explicit
--     local/dev `persistence migrate`. It owns all tables, so it stays the
--     migration role (ALTER TABLE requires ownership).
--   - minsky_preview — read-only sibling (scripts/supabase-preview-role.sql, mt#2096).
--
-- Run once against the production Supabase database AS the `postgres` role
-- (default privileges below bind to the executing role — postgres must be the
-- one granting, since migrations run as postgres and create the future tables):
--
--   psql "$ADMIN_URL" -v app_password="$APP_PW" -f scripts/supabase-app-role.sql
--
-- Pass the password via -v (psql variable) so it never appears in the script,
-- shell history, or transcript. Generate with e.g.: openssl rand -hex 24
-- (hex = URL-safe, no percent-encoding needed in the connection string).
--
-- Re-running is a no-op for an existing role (CREATE ROLE is skipped — the
-- password is NOT updated). To rotate the password:
--   psql "$ADMIN_URL" -v app_password="$NEW_PW" \
--     -c "ALTER ROLE minsky_app WITH PASSWORD :'app_password'"
--
-- Connection string (Supavisor shared pooler; same host/port/db as the postgres
-- URL): postgres protocol, user = minsky_app.<project-ref> (role-qualified),
-- password from above, host/port/db identical to the postgres-role URL.
--
-- Verification (acceptance test mt#2542 AT1):
--   psql "$APP_URL" -c 'CREATE TABLE mt2542_probe(i int)'   -- must FAIL: permission denied
--   psql "$APP_URL" -c 'SELECT count(*) FROM tasks'          -- must succeed

-- Refuse to run without the password variable (psql would otherwise substitute
-- the literal text as the password). ON_ERROR_STOP makes any failure abort the
-- run with a non-zero exit code instead of continuing in an aborted transaction.
\set ON_ERROR_STOP on
\if :{?app_password}
\else
DO $$ BEGIN RAISE EXCEPTION 'app_password not set. Run with: psql ... -v app_password="$APP_PW" -f scripts/supabase-app-role.sql'; END $$;
\endif

BEGIN;

-- Create the role (idempotent — skips if it already exists)
SELECT format('CREATE ROLE minsky_app WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'minsky_app')
\gexec

-- DML on all existing public tables + sequence usage (nextval for serial/identity ids)
GRANT USAGE ON SCHEMA public TO minsky_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO minsky_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO minsky_app;

-- Future tables/sequences created by migrations (which run as postgres — the
-- role executing this script) must auto-grant DML to minsky_app, or every new
-- migration-created table breaks the runtime until a manual grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO minsky_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO minsky_app;

-- Drizzle migration ledger: the runtime READS it (boot-time pending-check,
-- `persistence check`, fail-loud persistence health mt#2949) but never writes
-- it — only the migrator (postgres) does. Guarded so the script stays
-- re-runnable on a DB where migrations have not created the schema yet
-- (fresh DB, non-prod replica) — same pattern as supabase-preview-role.sql.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_namespace WHERE nspname = 'drizzle') THEN
    GRANT USAGE ON SCHEMA drizzle TO minsky_app;
    GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO minsky_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA drizzle GRANT SELECT ON TABLES TO minsky_app;
  END IF;
END
$$;

COMMIT;

-- NOT granted (deliberately):
--   - CREATE on any schema (no DDL — the whole point; verified live 2026-07-21:
--     `CREATE EXTENSION IF NOT EXISTS vector` in PostgresVectorStorage.initialize()
--     notice-skips without error under a no-CREATE role when the extension exists)
--   - TRUNCATE (no runtime TRUNCATE exists; DELETE covers data removal)
--   - drizzle write access (ledger is migrator-owned)
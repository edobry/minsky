-- supavisor-init.sql
--
-- Postgres initialization for the Supavisor metadata schema.
-- Runs via docker-entrypoint-initdb.d before Supavisor migrations start.
-- Tasks: mt#1205 (umbrella), mt#1365 (child C – local docker harness)
--
-- Supavisor's Ecto migrations store tenant/user data in the _supavisor schema.
-- That schema must exist before the migrate container runs or the migration
-- fails with: ERROR 3F000 (invalid_schema_name) schema "_supavisor" does not exist.

CREATE SCHEMA IF NOT EXISTS _supavisor;

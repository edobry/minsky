/**
 * Reviewer service Drizzle DB client.
 *
 * Module-singleton connection to the shared Postgres database.
 * Sealed: no imports from src/.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { reviewerSchema as schema } from "./schema";

/**
 * Resolve Postgres connection string from environment variables.
 *
 * Resolution order (mt#2121 — align with domain's canonical env var):
 *   1. MINSKY_PERSISTENCE_POSTGRES_URL — canonical name used by the domain container
 *   2. MINSKY_SESSIONDB_POSTGRES_URL   — legacy name (pre-mt#2121)
 *   3. MINSKY_POSTGRES_URL             — broader legacy fallback
 *   4. Development default
 */
/**
 * The env vars this service reads a connection string from, in resolution
 * order. Exported so a script that GATES on "is a DB reachable?" can ask the
 * same question the service answers, instead of hand-copying the list and
 * drifting from it.
 *
 * Note what is deliberately NOT here: `DATABASE_URL`. It is a common convention
 * and this service has never honored it, so a script that accepted it would
 * connect where the service would not — which is worse than skipping. A gate
 * built on this list can say exactly which vars it honors (mt#4881 PR #3561 R1).
 */
export const CONNECTION_STRING_ENV_VARS = [
  "MINSKY_PERSISTENCE_POSTGRES_URL",
  "MINSKY_SESSIONDB_POSTGRES_URL",
  "MINSKY_POSTGRES_URL",
] as const;

/** First set value among `CONNECTION_STRING_ENV_VARS`, or undefined. */
export function findConnectionStringEnvVar(): string | undefined {
  return CONNECTION_STRING_ENV_VARS.find((name) => Boolean(process.env[name]));
}

function resolveConnectionString(): string {
  const name = findConnectionStringEnvVar();
  const url = name ? process.env[name] : undefined;
  if (url) {
    return url;
  }
  // Development fallback — mirrors root config
  return "postgresql://localhost:5432/minsky";
}

export type ReviewerDb = ReturnType<typeof createDb>;

/**
 * Create a Drizzle DB instance backed by a postgres-js connection pool.
 *
 * Call once at startup and reuse throughout the process lifetime.
 */
export function createDb() {
  const connectionString = resolveConnectionString();
  const sql = postgres(connectionString);
  return drizzle(sql, { schema });
}

// ---------------------------------------------------------------------------
// Module singleton
// ---------------------------------------------------------------------------

let _db: ReviewerDb | null = null;

/**
 * Return the module-scoped DB singleton, creating it on first call.
 *
 * Tests that need an isolated DB instance should call createDb() directly
 * rather than using this singleton.
 */
export function getDb(): ReviewerDb {
  if (_db === null) {
    _db = createDb();
  }
  return _db;
}

/**
 * Reviewer service Drizzle DB client.
 *
 * Module-singleton connection to the shared Postgres database.
 * Sealed: no imports from src/.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schemas/convergence-metrics-schema";

/**
 * Resolve Postgres connection string from environment variables.
 * Matches root drizzle.pg.config.ts resolution order.
 */
function resolveConnectionString(): string {
  const url = process.env.MINSKY_SESSIONDB_POSTGRES_URL || process.env.MINSKY_POSTGRES_URL;
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

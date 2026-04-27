/**
 * Reviewer migration runner.
 *
 * Applies pending migrations from services/reviewer/migrations/pg/ at
 * startup using drizzle-orm/postgres-js/migrator. Called before the webhook
 * server starts listening.
 *
 * Sealed: no imports from src/.
 */

import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { ReviewerDb } from "./client";

/**
 * Apply all pending reviewer migrations.
 *
 * Throws on any migration error — callers should catch, log, and exit
 * non-zero (fail-fast semantics).
 *
 * @param db - Drizzle DB instance to run migrations against
 */
export async function applyMigrations(db: ReviewerDb): Promise<void> {
  await migrate(db, {
    migrationsFolder: "services/reviewer/migrations/pg",
  });
}

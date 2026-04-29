/**
 * Reviewer migration runner.
 *
 * Applies pending migrations from services/reviewer/migrations/pg/ at
 * startup using drizzle-orm/postgres-js/migrator. Called before the webhook
 * server starts listening.
 *
 * Sealed: no imports from src/.
 */

import { join } from "node:path";
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
  // Resolve migrations folder relative to this source file so the path is
  // correct regardless of the process working directory. From
  // services/reviewer/src/db/ (import.meta.dir), go up two levels to reach
  // services/reviewer/, then descend into migrations/pg/.
  await migrate(db, {
    migrationsFolder: join(import.meta.dir, "..", "..", "migrations", "pg"),
  });
}

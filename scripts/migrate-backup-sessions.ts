#!/usr/bin/env bun

/**
 * Simple migration script to import sessions from JSON backup to SQLite
 * Usage: bun run scripts/migrate-backup-sessions.ts
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { createStorageBackend } from "../src/domain/storage/storage-backend-factory";
import { log } from "../src/utils/logger";
import type { SessionRecord } from "../src/domain/session/session-db";

const BACKUP_FILE = "/Users/edobry/.local/state/minsky/session-db-backup-1750696515391.json";
const SQLITE_PATH = "/Users/edobry/.local/state/minsky/sessions.db";

async function migrateBackupToSqlite(): Promise<void> {
  log.info("Starting migration from backup to SQLite");

  // Check backup file exists
  if (!existsSync(BACKUP_FILE)) {
    throw new Error(`Backup file not found: ${BACKUP_FILE}`);
  }

  // Read backup data
  const backupContent = readFileSync(BACKUP_FILE, "utf8");
  const backupData: Record<string, SessionRecord> = JSON.parse(backupContent);
  const sessionCount = Object.keys(backupData).length;

  log.info(`Found ${sessionCount} sessions in backup file`);

  // Create SQLite storage backend
  const storage = createStorageBackend({
    backend: "sqlite",
    sqlite: { dbPath: SQLITE_PATH },
  });

  await storage.initialize();

  // Check current state
  const currentState = await storage.readState();
  const currentSessionCount = currentState.success && currentState.data
    ? currentState.data.sessions.length
    : 0;

  log.info(`Current SQLite database has ${currentSessionCount} sessions`);

  // Migrate sessions
  const sessionRecords = Object.values(backupData);
  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const session of sessionRecords) {
    try {
      // Check if session already exists
      const existing = await storage.getEntity(session.session);
      if (existing) {
        log.debug(`Session ${session.session} already exists, skipping`);
        skipped++;
        continue;
      }

      // Create the session
      await storage.createEntity(session);
      migrated++;
      log.debug(`Migrated session: ${session.session}`);
    } catch (error) {
      errors++;
      log.error(`Failed to migrate session ${session.session}:`, error as Error);
    }
  }

  log.info("Migration complete:");
  log.info(`  - Migrated: ${migrated} sessions`);
  log.info(`  - Skipped: ${skipped} sessions (already existed)`);
  log.info(`  - Errors: ${errors} sessions`);

  // Verify final state
  const finalState = await storage.readState();
  const finalSessionCount = finalState.success && finalState.data
    ? finalState.data.sessions.length
    : 0;

  log.info(`Final SQLite database has ${finalSessionCount} sessions`);

  if (finalSessionCount >= sessionCount) {
    log.info("✅ Migration successful! All sessions are now in SQLite database.");
  } else {
    log.warn(`⚠️  Migration may be incomplete. Expected ${sessionCount} sessions, found ${finalSessionCount}`);
  }
}

// Run the migration
migrateBackupToSqlite().catch((error) => {
  log.error("Migration failed:", error as Error);
  process.exit(1);
}); 

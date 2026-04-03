#!/usr/bin/env bun

/**
 * Session Data Cleanup Script
 *
 * This script:
 * 1. Creates a backup of the original session-db.json
 * 2. Deduplicates session records (keeping the most recent)
 * 3. Fixes data quality issues (undefined vs null)
 * 4. Validates the cleaned data
 * 5. Prepares for SQLite migration
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs";
import { join } from "path";
import { processExit } from "../src/utils/process";

interface SessionRecord {
  session: string;
  branch?: string;
  createdAt: string;
  repoName?: string;
  repoPath?: string;
  repoUrl?: string;
  taskId?: string;
}

const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
const sessionDbPath = join(xdgStateHome, "minsky", "session-db.json");
const backupPath = join(xdgStateHome, "minsky", `session-db-backup-${Date.now()}.json`);
const cleanedPath = join(xdgStateHome, "minsky", "session-db-cleaned.json");

function createBackup(): void {
  if (!existsSync(sessionDbPath)) {
    console.error(`❌ Session database not found at: ${sessionDbPath}`);
    processExit(1);
  }

  console.log("📦 Creating backup...");
  copyFileSync(sessionDbPath, backupPath);
  console.log(`✅ Backup created: ${backupPath}`);
}

function loadSessionData(): SessionRecord[] {
  console.log("📖 Loading session data...");
  const data = readFileSync(sessionDbPath, "utf-8");
  const sessions = JSON.parse(data) as SessionRecord[];
  console.log(`📊 Loaded ${sessions.length} session records`);
  return sessions;
}

function deduplicateSessions(sessions: SessionRecord[]): SessionRecord[] {
  console.log("🔄 Deduplicating sessions...");

  const sessionMap = new Map<string, SessionRecord>();
  let duplicateCount = 0;

  for (const session of sessions) {
    const existingSession = sessionMap.get(session.session);

    if (existingSession) {
      duplicateCount++;
      // Keep the session with the most recent createdAt timestamp
      const existingTime = new Date(existingSession.createdAt).getTime();
      const currentTime = new Date(session.createdAt).getTime();

      if (currentTime > existingTime) {
        sessionMap.set(session.session, session);
        console.log(
          `  🔄 Updated ${session.session}: ${existingSession.createdAt} → ${session.createdAt}`
        );
      }
    } else {
      sessionMap.set(session.session, session);
    }
  }

  const deduplicated = Array.from(sessionMap.values());
  console.log(
    `✅ Removed ${duplicateCount} duplicates (${sessions.length} → ${deduplicated.length})`
  );

  return deduplicated;
}

function cleanSessionData(sessions: SessionRecord[]): SessionRecord[] {
  console.log("🧹 Cleaning session data...");

  let fixedCount = 0;

  const cleaned = sessions
    .map((session) => {
      const cleanedSession: SessionRecord = { ...session };
      let sessionFixed = false;

      // Fix undefined values to null for optional fields
      const optionalFields: (keyof SessionRecord)[] = ["branch", "repoPath", "taskId"];

      for (const field of optionalFields) {
        if (cleanedSession[field] === undefined) {
          // Remove undefined fields entirely (they'll be null in SQLite)
          delete cleanedSession[field];
          sessionFixed = true;
        }
      }

      // Ensure required fields have valid values
      if (!cleanedSession.session || cleanedSession.session.trim() === "") {
        console.warn(`⚠️  Session with empty ID found, skipping: ${JSON.stringify(session)}`);
        return null;
      }

      if (!cleanedSession.createdAt) {
        console.warn(`⚠️  Session ${cleanedSession.session} missing createdAt, using current time`);
        cleanedSession.createdAt = new Date().toISOString();
        sessionFixed = true;
      }

      // Validate and fix createdAt format
      try {
        const date = new Date(cleanedSession.createdAt);
        if (isNaN(date.getTime())) {
          console.warn(
            `⚠️  Session ${cleanedSession.session} has invalid createdAt, using current time`
          );
          cleanedSession.createdAt = new Date().toISOString();
          sessionFixed = true;
        } else {
          // Ensure ISO format
          cleanedSession.createdAt = date.toISOString();
        }
      } catch (error) {
        console.warn(
          `⚠️  Session ${cleanedSession.session} has invalid createdAt, using current time`
        );
        cleanedSession.createdAt = new Date().toISOString();
        sessionFixed = true;
      }

      if (sessionFixed) {
        fixedCount++;
      }

      return cleanedSession;
    })
    .filter((session): session is SessionRecord => session !== null);

  console.log(`✅ Fixed ${fixedCount} sessions with data quality issues`);
  return cleaned;
}

function validateCleanedData(sessions: SessionRecord[]): boolean {
  console.log("🔍 Validating cleaned data...");

  const sessionIds = new Set<string>();
  let validationErrors = 0;

  for (const session of sessions) {
    // Check for duplicates
    if (sessionIds.has(session.session)) {
      console.error(`❌ Duplicate session ID found: ${session.session}`);
      validationErrors++;
    }
    sessionIds.add(session.session);

    // Check required fields
    if (!session.session || !session.createdAt) {
      console.error(`❌ Missing required fields in session: ${JSON.stringify(session)}`);
      validationErrors++;
    }

    // Check for undefined values
    for (const [key, value] of Object.entries(session)) {
      if (value === undefined) {
        console.error(`❌ Undefined value found in session ${session.session}, field: ${key}`);
        validationErrors++;
      }
    }
  }

  if (validationErrors === 0) {
    console.log(`✅ Validation passed: ${sessions.length} unique, valid sessions`);
    return true;
  } else {
    console.error(`❌ Validation failed: ${validationErrors} errors found`);
    return false;
  }
}

function saveCleanedData(sessions: SessionRecord[]): void {
  console.log("💾 Saving cleaned data...");
  writeFileSync(cleanedPath, JSON.stringify(sessions, null, 2));
  console.log(`✅ Cleaned data saved: ${cleanedPath}`);
}

function replaceOriginalData(sessions: SessionRecord[]): void {
  console.log("🔄 Replacing original session database...");
  writeFileSync(sessionDbPath, JSON.stringify(sessions, null, 2));
  console.log("✅ Original database updated with cleaned data");
}

function printSummary(originalCount: number, finalCount: number): void {
  console.log("\n📋 CLEANUP SUMMARY");
  console.log("===================");
  console.log(`Original records: ${originalCount}`);
  console.log(`Final records: ${finalCount}`);
  console.log(`Records removed: ${originalCount - finalCount}`);
  console.log(`Backup location: ${backupPath}`);
  console.log(`Cleaned data: ${cleanedPath}`);
  console.log("\n✅ Session data cleanup complete!");
  console.log("\n🔄 Next steps:");
  console.log("1. Review the cleaned data if needed");
  console.log("2. Run: minsky config migrate sqlite --dry-run --verify");
  console.log("3. If satisfied, run: minsky config migrate sqlite --verify");
}

async function main(): Promise<void> {
  try {
    console.log("🚀 Starting session data cleanup...");

    // Step 1: Create backup
    createBackup();

    // Step 2: Load original data
    const originalSessions = loadSessionData();
    const originalCount = originalSessions.length;

    // Step 3: Deduplicate
    const deduplicated = deduplicateSessions(originalSessions);

    // Step 4: Clean data quality issues
    const cleaned = cleanSessionData(deduplicated);

    // Step 5: Validate cleaned data
    const isValid = validateCleanedData(cleaned);

    if (!isValid) {
      console.error("❌ Validation failed. Please review the errors above.");
      console.log(`📦 Original data is safely backed up at: ${backupPath}`);
      processExit(1);
    }

    // Step 6: Save cleaned data
    saveCleanedData(cleaned);

    // Step 7: Replace original with cleaned data
    replaceOriginalData(cleaned);

    // Step 8: Print summary
    printSummary(originalCount, cleaned.length);
  } catch (error) {
    console.error("❌ Error during cleanup:", error);
    console.log(`📦 Original data is safely backed up at: ${backupPath}`);
    processExit(1);
  }
}

// Run the script
if (import.meta.main) {
  main();
}

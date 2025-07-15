#!/usr/bin/env bun

/**
 * Normalize Session Task IDs
 *
 * This script normalizes task IDs in session records to ensure consistent formatting.
 * It converts task IDs from plain numbers (e.g., "244") to the standard format with
 * hash prefix (e.g., "#244") used by the current system.
 */

import { createSessionProvider, type SessionRecord } from "../src/domain/session";
import { log } from "../src/utils/logger";

interface TaskIdNormalization {
  sessionName: string;
  oldTaskId: string;
  newTaskId: string;
  record: SessionRecord;
}

/**
 * Main normalization function
 */
async function normalizeSessionTaskIds(options: {
  dryRun?: boolean;
  verbose?: boolean;
} = {}): Promise<void> {
  const { dryRun = true, verbose = false } = options;

  log.cli("🔍 Scanning for sessions with inconsistent task ID formats...");

  const sessionDB = createSessionProvider();

  // Get all sessions
  const allSessions = await sessionDB.listSessions();
  log.cli(`Found ${allSessions.length} total sessions`);

  // Find sessions with task IDs that need normalization
  const sessionsToNormalize: TaskIdNormalization[] = [];

  for (const session of allSessions) {
    if (session.taskId) {
      // Check if task ID needs normalization (doesn't start with #)
      if (!session.taskId.startsWith("#")) {
        const normalizedTaskId = `#${session.taskId}`;

        sessionsToNormalize.push({
          sessionName: session.session,
          oldTaskId: session.taskId,
          newTaskId: normalizedTaskId,
          record: session,
        });

        if (verbose) {
          log.cli(`Found session needing normalization: ${session.session} (${session.taskId} -> ${normalizedTaskId})`);
        }
      }
    }
  }

  if (sessionsToNormalize.length === 0) {
    log.cli("✅ All session task IDs are already in the correct format (#XXX).");
    return;
  }

  // Display results
  log.cli("\n📊 TASK ID NORMALIZATION REPORT");
  log.cli("=".repeat(50));
  log.cli(`Total sessions: ${allSessions.length}`);
  log.cli(`Sessions with task IDs: ${allSessions.filter(s => s.taskId).length}`);
  log.cli(`Sessions needing normalization: ${sessionsToNormalize.length}`);

  log.cli("\n🔧 SESSIONS TO NORMALIZE:");
  for (const session of sessionsToNormalize) {
    log.cli(`  • ${session.sessionName}: "${session.oldTaskId}" -> "${session.newTaskId}"`);
  }

  if (dryRun) {
    log.cli("\n🧪 DRY RUN MODE");
    log.cli(`Would normalize ${sessionsToNormalize.length} session task IDs`);
    log.cli("Run with --no-dry-run to actually normalize the task IDs");
  } else {
    // Actually normalize the task IDs
    log.cli(`\n🔧 Normalizing ${sessionsToNormalize.length} session task IDs...`);

    let successCount = 0;
    let errorCount = 0;

    for (const session of sessionsToNormalize) {
      try {
        // Update the session record with the normalized task ID
        await sessionDB.updateSession(session.sessionName, {
          taskId: session.newTaskId,
        });

        successCount++;
        log.cli(`✅ Normalized ${session.sessionName}: ${session.oldTaskId} -> ${session.newTaskId}`);
      } catch (error) {
        errorCount++;
        log.error(`❌ Failed to normalize ${session.sessionName}: ${error}`);
      }
    }

    log.cli("\n🎉 Normalization complete!");
    log.cli(`  ✅ Successfully normalized: ${successCount} sessions`);
    if (errorCount > 0) {
      log.cli(`  ❌ Failed to normalize: ${errorCount} sessions`);
    }

    // Verify the changes
    log.cli("\n🔍 Verifying changes...");
    const updatedSessions = await sessionDB.listSessions();
    const stillInconsistent = updatedSessions.filter(s => s.taskId && !s.taskId.startsWith("#"));

    if (stillInconsistent.length === 0) {
      log.cli("✅ All task IDs are now in consistent format!");
    } else {
      log.cli(`⚠️  ${stillInconsistent.length} sessions still have inconsistent task IDs`);
    }
  }
}

/**
 * CLI Interface
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes("--no-dry-run");
  const verbose = args.includes("--verbose");

  if (args.includes("--help")) {
    log.cli(`
Normalize Session Task IDs Tool

This script ensures all session task IDs use the consistent #XXX format.

Usage: bun scripts/normalize-session-task-ids.ts [options]

Options:
  --no-dry-run    Actually normalize the task IDs (default: dry run only)
  --verbose       Show detailed analysis for each session
  --help          Show this help message

Examples:
  bun scripts/normalize-session-task-ids.ts                    # Dry run analysis
  bun scripts/normalize-session-task-ids.ts --verbose          # Verbose dry run
  bun scripts/normalize-session-task-ids.ts --no-dry-run       # Actually normalize
`);
    process.exit(0);
  }

  try {
    await normalizeSessionTaskIds({
      dryRun,
      verbose,
    });
  } catch (error) {
    log.error(`Normalization failed: ${error}`);
    process.exit(1);
  }
}

// Run the script
main();

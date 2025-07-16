#!/usr/bin/env bun

/**
 * Fix Orphaned Task Sessions
 * 
 * This script identifies sessions that have task numbers in their names
 * but are missing the taskId field in their session record. It then
 * updates the session records to properly associate them with their tasks.
 */

import { createSessionProvider, type SessionRecord } from "../src/domain/session";
import { TaskService } from "../src/domain/tasks/taskService";
import { log } from "../src/utils/logger";

interface OrphanedSession {
  sessionName: string;
  inferredTaskId: string;
  taskExists: boolean;
  record: SessionRecord;
}

/**
 * Main function to fix orphaned task sessions
 */
async function fixOrphanedTaskSessions(options: {
  dryRun?: boolean;
  verbose?: boolean;
} = {}): Promise<void> {
  const { dryRun = true, verbose = false } = options;
  
  log.cli("🔍 Scanning for orphaned task sessions...");
  
  const sessionDB = createSessionProvider();
  const taskService = new TaskService({
    workspacePath: process.cwd(),
    backend: "markdown",
  });
  
  // Get all sessions
  const allSessions = await sessionDB.listSessions();
  
  // Find sessions without taskId but with numeric names
  const orphanedSessions: OrphanedSession[] = [];
  
  for (const session of allSessions) {
    if (!session.taskId) {
      // Check if session name is just a number (task ID)
      const numericMatch = session.session.match(/^(\d+)$/);
      if (numericMatch) {
        const taskNumber = numericMatch[1];
        const taskId = `#${taskNumber}`;
        
        // Check if this task actually exists
        const taskExists = await taskService.getTask(taskId) !== null;
        
        orphanedSessions.push({
          sessionName: session.session,
          inferredTaskId: taskId,
          taskExists,
          record: session,
        });
        
        if (verbose) {
          log.cli(`Found orphaned session: ${session.session} -> ${taskId} (task exists: ${taskExists})`);
        }
      }
    }
  }
  
  if (orphanedSessions.length === 0) {
    log.cli("✅ No orphaned task sessions found.");
    return;
  }
  
  // Display results
  log.cli("\n📊 ORPHANED SESSIONS REPORT");
  log.cli("=".repeat(50));
  log.cli(`Total sessions: ${allSessions.length}`);
  log.cli(`Orphaned sessions: ${orphanedSessions.length}`);
  
  const validOrphans = orphanedSessions.filter(s => s.taskExists);
  const invalidOrphans = orphanedSessions.filter(s => !s.taskExists);
  
  if (validOrphans.length > 0) {
    log.cli("\n✅ VALID ORPHANED SESSIONS (task exists):");
    for (const session of validOrphans) {
      log.cli(`  • ${session.sessionName} -> ${session.inferredTaskId}`);
    }
  }
  
  if (invalidOrphans.length > 0) {
    log.cli("\n⚠️  INVALID ORPHANED SESSIONS (task doesn't exist):");
    for (const session of invalidOrphans) {
      log.cli(`  • ${session.sessionName} -> ${session.inferredTaskId} (task not found)`);
    }
  }
  
  if (dryRun) {
    log.cli("\n🧪 DRY RUN MODE");
    log.cli(`Would fix ${validOrphans.length} valid orphaned sessions`);
    log.cli(`Would skip ${invalidOrphans.length} invalid orphaned sessions`);
    log.cli("Run with --no-dry-run to actually fix the associations");
  } else {
    // Actually fix the valid orphaned sessions
    if (validOrphans.length > 0) {
      log.cli(`\n🔧 Fixing ${validOrphans.length} orphaned sessions...`);
      
      for (const session of validOrphans) {
        try {
          // Update the session record with the task ID
          await sessionDB.updateSession(session.sessionName, {
            taskId: session.inferredTaskId,
          });
          
          log.cli(`✅ Fixed ${session.sessionName} -> ${session.inferredTaskId}`);
        } catch (error) {
          log.error(`❌ Failed to fix ${session.sessionName}: ${error}`);
        }
      }
      
      log.cli(`\n🎉 Successfully fixed ${validOrphans.length} orphaned sessions!`);
    }
    
    if (invalidOrphans.length > 0) {
      log.cli(`\n⚠️  ${invalidOrphans.length} sessions remain unfixed (tasks don't exist)`);
      log.cli("These sessions may need manual review or cleanup");
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
Fix Orphaned Task Sessions Tool

Usage: bun scripts/fix-orphaned-task-sessions.ts [options]

Options:
  --no-dry-run    Actually fix the session associations (default: dry run only)
  --verbose       Show detailed analysis for each session
  --help          Show this help message

Examples:
  bun scripts/fix-orphaned-task-sessions.ts                    # Dry run analysis
  bun scripts/fix-orphaned-task-sessions.ts --verbose          # Verbose dry run
  bun scripts/fix-orphaned-task-sessions.ts --no-dry-run       # Actually fix the sessions
`);
    process.exit(0);
  }
  
  try {
    await fixOrphanedTaskSessions({
      dryRun,
      verbose,
    });
  } catch (error) {
    log.error(`Fix failed: ${error}`);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.main) {
  main();
}

export { fixOrphanedTaskSessions }; 

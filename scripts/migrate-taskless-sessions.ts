#!/usr/bin/env bun

/**
 * Migration Script: Taskless Sessions Cleanup
 * 
 * This script migrates existing taskless sessions to ensure 100% task association.
 * It scans for sessions without task IDs, checks for unmerged work, and provides
 * migration options.
 */

import { existsSync } from "fs";
import { readdir, stat as fsStat } from "fs/promises";
import { join } from "path";
import { createSessionProvider, type SessionRecord } from "../src/domain/session";
import { createGitService } from "../src/domain/git";
import { log } from "../src/utils/logger";

interface TasklessSession {
  record: SessionRecord;
  workdir: string;
  hasUnmergedWork: boolean;
  hasLocalChanges: boolean;
  lastModified: Date;
  directorySize: number;
}

interface MigrationReport {
  totalSessions: number;
  tasklessSessions: TasklessSession[];
  safeToDelete: TasklessSession[];
  requiresManualReview: TasklessSession[];
  summary: {
    canAutoDelete: number;
    needsReview: number;
    totalSize: number;
  };
}

/**
 * Main migration function
 */
async function migrateTasklessSessions(options: {
  dryRun?: boolean;
  autoDelete?: boolean;
  verbose?: boolean;
} = {}): Promise<MigrationReport> {
  const { dryRun = true, autoDelete = false, verbose = false } = options;
  
  log.cli("🔍 Starting taskless sessions migration scan...");
  
  const sessionDB = createSessionProvider();
  const gitService = createGitService();
  
  // Get all sessions
  const allSessions = await sessionDB.listSessions();
  log.cli(`Found ${allSessions.length} total sessions`);
  
  // Filter taskless sessions
  const tasklessSessions = allSessions.filter((session) => !session.taskId);
  
  if (tasklessSessions.length === 0) {
    log.cli("✅ No taskless sessions found. Migration not needed.");
    return {
      totalSessions: allSessions.length,
      tasklessSessions: [],
      safeToDelete: [],
      requiresManualReview: [],
      summary: {
        canAutoDelete: 0,
        needsReview: 0,
        totalSize: 0,
      },
    };
  }
  
  log.cli(`⚠️  Found ${tasklessSessions.length} taskless sessions`);
  
  // Analyze each taskless session
  const analysisResults: TasklessSession[] = [];
  
  for (const sessionRecord of tasklessSessions) {
    if (verbose) {
      log.cli(`Analyzing session: ${sessionRecord.session}`);
    }
    
    const workdir = await sessionDB.getSessionWorkdir(sessionRecord.session);
    const analysis = await analyzeSession(sessionRecord, workdir, gitService);
    analysisResults.push(analysis);
  }
  
  // Categorize sessions
  const safeToDelete = analysisResults.filter(
    (session) => !session.hasUnmergedWork && !session.hasLocalChanges
  );
  const requiresManualReview = analysisResults.filter(
    (session) => session.hasUnmergedWork || session.hasLocalChanges
  );
  
  // Generate report
  const report: MigrationReport = {
    totalSessions: allSessions.length,
    tasklessSessions: analysisResults,
    safeToDelete,
    requiresManualReview,
    summary: {
      canAutoDelete: safeToDelete.length,
      needsReview: requiresManualReview.length,
      totalSize: analysisResults.reduce((sum, session) => sum + session.directorySize, 0),
    },
  };
  
  // Display report
  await displayMigrationReport(report);
  
  // Perform cleanup if requested
  if (autoDelete && !dryRun && safeToDelete.length > 0) {
    await performCleanup(safeToDelete, sessionDB);
  }
  
  return report;
}

/**
 * Analyze a single session for unmerged work and local changes
 */
async function analyzeSession(
  sessionRecord: SessionRecord,
  workdir: string,
  gitService: any
): Promise<TasklessSession> {
  let hasUnmergedWork = false;
  let hasLocalChanges = false;
  let lastModified = new Date(sessionRecord.createdAt);
  let directorySize = 0;
  
  try {
    if (!existsSync(workdir)) {
      // Session directory doesn't exist - safe to delete
      return {
        record: sessionRecord,
        workdir,
        hasUnmergedWork: false,
        hasLocalChanges: false,
        lastModified,
        directorySize: 0,
      };
    }
    
    // Calculate directory size
    directorySize = await getDirectorySize(workdir);
    
    // Get last modified time from git or filesystem
    try {
      const gitLog = await gitService.log({
        workdir,
        maxCount: 1,
      });
      if (gitLog && gitLog.length > 0) {
        lastModified = new Date(gitLog[0].date);
      }
    } catch (error) {
      // Fall back to filesystem stat
      const stats = await fsStat(workdir);
      lastModified = stats.mtime;
    }
    
    // Check for local changes
    try {
      const status = await gitService.status({ workdir });
      hasLocalChanges = status.files && status.files.length > 0;
    } catch (error) {
      // If git status fails, assume there might be changes
      hasLocalChanges = true;
    }
    
    // Check for unmerged work (commits ahead of main)
    try {
      const commits = await gitService.log({
        workdir,
        from: "HEAD",
        to: "origin/main",
      });
      hasUnmergedWork = commits && commits.length > 0;
    } catch (error) {
      // If we can't determine merge status, err on the side of caution
      hasUnmergedWork = true;
    }
    
  } catch (error) {
    log.warn(`Failed to analyze session ${sessionRecord.session}: ${error}`);
    // When in doubt, require manual review
    hasUnmergedWork = true;
    hasLocalChanges = true;
  }
  
  return {
    record: sessionRecord,
    workdir,
    hasUnmergedWork,
    hasLocalChanges,
    lastModified,
    directorySize,
  };
}

/**
 * Calculate directory size recursively
 */
async function getDirectorySize(dirPath: string): Promise<number> {
  try {
    const files = await readdir(dirPath);
    let totalSize = 0;
    
    for (const file of files) {
      const filePath = join(dirPath, file);
      const stats = await fsStat(filePath);
      
      if (stats.isDirectory()) {
        totalSize += await getDirectorySize(filePath);
      } else {
        totalSize += stats.size;
      }
    }
    
    return totalSize;
  } catch (error) {
    return 0;
  }
}

/**
 * Display comprehensive migration report
 */
async function displayMigrationReport(report: MigrationReport): Promise<void> {
  log.cli("\n📊 MIGRATION REPORT");
  log.cli("=".repeat(50));
  
  log.cli(`Total sessions: ${report.totalSessions}`);
  log.cli(`Taskless sessions: ${report.tasklessSessions.length}`);
  log.cli(`Safe to auto-delete: ${report.summary.canAutoDelete}`);
  log.cli(`Require manual review: ${report.summary.needsReview}`);
  log.cli(`Total storage used: ${formatBytes(report.summary.totalSize)}`);
  
  if (report.safeToDelete.length > 0) {
    log.cli("\n✅ SAFE TO DELETE (no unmerged work):");
    for (const session of report.safeToDelete) {
      log.cli(`  • ${session.record.session} (${formatBytes(session.directorySize)}, last modified: ${session.lastModified.toLocaleDateString()})`);
    }
  }
  
  if (report.requiresManualReview.length > 0) {
    log.cli("\n⚠️  REQUIRES MANUAL REVIEW:");
    for (const session of report.requiresManualReview) {
      const reasons = [];
      if (session.hasUnmergedWork) reasons.push("unmerged commits");
      if (session.hasLocalChanges) reasons.push("local changes");
      
      log.cli(`  • ${session.record.session} (${formatBytes(session.directorySize)}) - ${reasons.join(", ")}`);
      log.cli(`    Path: ${session.workdir}`);
    }
    
    log.cli("\n🔧 MANUAL REVIEW INSTRUCTIONS:");
    log.cli("For sessions with unmerged work:");
    log.cli("1. cd to the session directory");
    log.cli("2. Review changes with: git log --oneline origin/main..HEAD");
    log.cli("3. Create PR if valuable work: minsky session pr --title \"Save work from session\"");
    log.cli("4. Or abandon: git reset --hard origin/main && rm -rf <session-dir>");
  }
  
  log.cli("\n💡 NEXT STEPS:");
  if (report.summary.canAutoDelete > 0) {
    log.cli(`Run with --auto-delete --no-dry-run to clean up ${report.summary.canAutoDelete} empty sessions`);
  }
  if (report.summary.needsReview > 0) {
    log.cli(`Manually review ${report.summary.needsReview} sessions with potential work`);
  }
  if (report.tasklessSessions.length === 0) {
    log.cli("Migration complete! All sessions now have task association.");
  }
}

/**
 * Perform actual cleanup of safe-to-delete sessions
 */
async function performCleanup(
  sessionsToDelete: TasklessSession[],
  sessionDB: any
): Promise<void> {
  log.cli(`\n🧹 Cleaning up ${sessionsToDelete.length} empty sessions...`);
  
  for (const session of sessionsToDelete) {
    try {
      // Delete from database
      await sessionDB.deleteSession(session.record.session);
      log.cli(`✅ Deleted session: ${session.record.session}`);
    } catch (error) {
      log.error(`❌ Failed to delete session ${session.record.session}: ${error}`);
    }
  }
  
  log.cli("🎉 Cleanup complete!");
}

/**
 * Format bytes to human readable format
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))  } ${  sizes[i]}`;
}

/**
 * CLI Interface
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes("--no-dry-run");
  const autoDelete = args.includes("--auto-delete");
  const verbose = args.includes("--verbose");
  
  if (args.includes("--help")) {
    log.cli(`
Taskless Sessions Migration Tool

Usage: bun scripts/migrate-taskless-sessions.ts [options]

Options:
  --no-dry-run    Actually perform cleanup (default: dry run only)
  --auto-delete   Automatically delete sessions with no unmerged work
  --verbose       Show detailed analysis for each session
  --help          Show this help message

Examples:
  bun scripts/migrate-taskless-sessions.ts                    # Dry run analysis
  bun scripts/migrate-taskless-sessions.ts --auto-delete     # Delete empty sessions (dry run)
  bun scripts/migrate-taskless-sessions.ts --auto-delete --no-dry-run  # Actually delete
`);
    process.exit(0);
  }
  
  try {
    await migrateTasklessSessions({
      dryRun,
      autoDelete,
      verbose,
    });
  } catch (error) {
    log.error(`Migration failed: ${error}`);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.main) {
  main();
}

export { migrateTasklessSessions, type MigrationReport, type TasklessSession }; 

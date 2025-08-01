import {
  SessionMigrationService,
  type SessionMigrationOptions,
  type MigrationReport,
} from "../migration-command";
import type { SessionProviderInterface } from "../types";
import { createSessionProvider } from "../session-db-adapter";

/**
 * CLI parameters for session migration command
 */
export interface SessionMigrateParameters {
  /** Preview migration without making changes */
  dryRun?: boolean;
  /** Create backup before migration (default: true) */
  backup?: boolean;
  /** Skip confirmation prompts */
  force?: boolean;
  /** Number of sessions to process in each batch (default: 50) */
  batchSize?: number;
  /** Show detailed progress information */
  verbose?: boolean;
  /** Show summary in JSON format */
  json?: boolean;
  /** Filter: only migrate sessions with specific task backend */
  backend?: string;
  /** Filter: only migrate sessions created before this date (ISO format) */
  createdBefore?: string;
  /** Filter: only migrate sessions matching this pattern (regex) */
  pattern?: string;
}

/**
 * Progress reporting for CLI
 */
function createProgressReporter(verbose: boolean) {
  return (progress: any) => {
    if (verbose) {
      console.log(
        `\r⚡ Batch ${progress.currentBatch}/${progress.totalBatches} | ` +
          `Processed: ${progress.processed} | ` +
          `Migrated: ${progress.migrated} | ` +
          `Failed: ${progress.failed}`
      );
    }
  };
}

/**
 * Format migration report for CLI output
 */
function formatMigrationReport(report: MigrationReport, json: boolean): string {
  if (json) {
    return JSON.stringify(report, null, 2);
  }

  const { progress, summary, executionTime, backupPath } = report;

  let output = `\n📊 **MIGRATION REPORT**\n\n`;

  // Progress Summary
  output += `**PROGRESS:**\n`;
  output += `  Total Sessions: ${progress.total}\n`;
  output += `  Needed Migration: ${progress.needsMigration}\n`;
  output += `  Successfully Migrated: ${progress.migrated}\n`;
  output += `  Failed: ${progress.failed}\n`;
  output += `  Already Modern: ${progress.alreadyMigrated}\n\n`;

  // Changes Summary
  output += `**CHANGES APPLIED:**\n`;
  output += `  Sessions Renamed: ${summary.sessionsRenamed}\n`;
  output += `  Task IDs Upgraded: ${summary.taskIdsUpgraded}\n`;
  output += `  Backends Added: ${summary.backendsAdded}\n`;
  output += `  Legacy IDs Preserved: ${summary.legacyIdsPreserved}\n\n`;

  // Execution Details
  output += `**EXECUTION:**\n`;
  output += `  Time: ${executionTime}ms\n`;
  if (backupPath) {
    output += `  Backup: ${backupPath}\n`;
  }

  // Individual Failures (if any)
  const failures = report.results.filter((r) => !r.success);
  if (failures.length > 0) {
    output += `\n❌ **FAILURES:**\n`;
    failures.forEach((failure) => {
      output += `  ${failure.original.session}: ${failure.error}\n`;
    });
  }

  return output;
}

/**
 * Ask for user confirmation
 */
async function askConfirmation(message: string): Promise<boolean> {
  // In a real implementation, this would use a proper CLI prompt library
  console.log(`\n${message}`);
  console.log(`⚠️  This will modify your session database.`);
  console.log(`📋 Use --dry-run to preview changes first.`);
  console.log(`💾 A backup will be created automatically (unless --backup=false).`);
  console.log(`\nProceed? (y/N)`);

  // For now, return true if --force was used (this would be handled by CLI framework)
  return true; // Placeholder - in real implementation would read from stdin
}

/**
 * Execute session migration command
 */
export async function sessionMigrate(
  params: SessionMigrateParameters,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
  }
): Promise<void> {
  const {
    dryRun = false,
    backup = true,
    force = false,
    batchSize = 50,
    verbose = false,
    json = false,
    backend,
    createdBefore,
    pattern,
  } = params;

  // Initialize dependencies
  const sessionDB = depsInput?.sessionDB || createSessionProvider();
  const migrationService = new SessionMigrationService(sessionDB);

  try {
    // Step 1: Analyze current state
    console.log("🔍 Analyzing session database...");
    const analysis = await migrationService.analyzeMigrationNeeds();

    if (analysis.needsMigration === 0) {
      console.log(
        "✅ No sessions need migration. All sessions are already using the modern format!"
      );
      return;
    }

    console.log(
      `📊 Found ${analysis.needsMigration} sessions that need migration (${analysis.total} total)`
    );

    // Step 2: Build migration options
    const migrationOptions: SessionMigrationOptions = {
      dryRun,
      backup,
      batchSize,
      filter: {
        ...(backend && { taskBackend: backend }),
        ...(createdBefore && { createdBefore }),
        ...(pattern && { sessionPattern: pattern }),
      },
    };

    // Step 3: Dry run or confirmation
    if (dryRun) {
      console.log("\n🔍 **DRY RUN** - Previewing migration (no changes will be made)");
    } else if (!force) {
      const confirmed = await askConfirmation(
        `Migrate ${analysis.needsMigration} sessions to multi-backend format?`
      );
      if (!confirmed) {
        console.log("❌ Migration cancelled by user");
        return;
      }
    }

    // Step 4: Execute migration
    console.log(`\n🚀 ${dryRun ? "Previewing" : "Executing"} migration...`);

    const progressReporter = createProgressReporter(verbose);
    const report = await migrationService.migrate(migrationOptions, progressReporter);

    // Step 5: Display results
    if (verbose || json) {
      console.log(formatMigrationReport(report, json));
    } else {
      // Concise summary
      if (dryRun) {
        console.log(`\n📋 **PREVIEW COMPLETE**`);
        console.log(`  Would migrate: ${report.progress.needsMigration} sessions`);
        console.log(`  Task IDs upgraded: ${report.summary.taskIdsUpgraded}`);
        console.log(`  Backends added: ${report.summary.backendsAdded}`);
      } else {
        console.log(`\n✅ **MIGRATION COMPLETE**`);
        console.log(`  Migrated: ${report.progress.migrated} sessions`);
        console.log(`  Failed: ${report.progress.failed} sessions`);
        console.log(`  Time: ${report.executionTime}ms`);

        if (report.backupPath) {
          console.log(`  Backup: ${report.backupPath}`);
        }

        if (report.progress.failed > 0) {
          console.log(`\n⚠️  Some sessions failed to migrate. Use --verbose for details.`);
        }
      }
    }

    // Step 6: Success guidance
    if (!dryRun && report.progress.migrated > 0) {
      console.log(`\n🎉 **MIGRATION SUCCESSFUL**`);
      console.log(`Your sessions now support multi-backend task system!`);
      console.log(`New sessions will use format: task-md#123, task-gh#456, etc.`);

      if (report.backupPath) {
        console.log(`\n💾 Backup saved to: ${report.backupPath}`);
        console.log(`To rollback: minsky session migrate-rollback ${report.backupPath}`);
      }
    }
  } catch (error) {
    console.error(
      `\n❌ Migration failed: ${error instanceof Error ? error.message : String(error)}`
    );
    throw error;
  }
}

/**
 * Rollback migration using backup
 */
export async function sessionMigrateRollback(
  backupPath: string,
  depsInput?: {
    sessionDB?: SessionProviderInterface;
  }
): Promise<void> {
  const sessionDB = depsInput?.sessionDB || createSessionProvider();
  const migrationService = new SessionMigrationService(sessionDB);

  try {
    console.log(`🔄 Rolling back migration from backup: ${backupPath}`);

    const success = await migrationService.rollback(backupPath);

    if (success) {
      console.log(`✅ Rollback successful! Sessions restored from backup.`);
    } else {
      console.error(`❌ Rollback failed. Please check the backup file path.`);
      throw new Error("Rollback failed: invalid backup file path");
    }
  } catch (error) {
    console.error(`❌ Rollback failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Session Data Migrator Implementation
 *
 * This module provides concrete implementation for migrating session data
 * between different storage backends with verification and backup capabilities.
 */

import { writeFile, readFile, existsSync } from "fs/promises";
import { dirname } from "path";
import { mkdirSync } from "fs";
import { log } from "../../../utils/logger";
import type { DatabaseStorage } from "../database-storage";
import type { SessionRecord, SessionDbState } from "../../session/session-db";
import type {
  DataMigrator,
  MigrationResult,
  VerificationResult,
  MigrationOptions,
  MigrationProgressCallback,
} from "./migration-interface";

/**
 * Default migration options
 */
const DEFAULT_MIGRATION_OPTIONS: Required<MigrationOptions> = {
  createBackup: true,
  backupPath: "",
  verifyAfterMigration: true,
  clearSourceAfterMigration: false,
  batchSize: 100,
  stopOnError: true,
};

/**
 * Session data migrator implementation
 */
export class SessionMigrator implements DataMigrator {
  private progressCallback?: MigrationProgressCallback;

  constructor(progressCallback?: MigrationProgressCallback) {
    this.progressCallback = progressCallback;
  }

  /**
   * Migrate data from source to target storage
   */
  async migrate(
    source: DatabaseStorage<SessionRecord, SessionDbState>,
    target: DatabaseStorage<SessionRecord, SessionDbState>,
    options: MigrationOptions = {}
  ): Promise<MigrationResult> {
    const startTime = Date.now();
    const opts = { ...DEFAULT_MIGRATION_OPTIONS, ...options };
    
    // Generate backup path if not provided
    if (opts.createBackup && !opts.backupPath) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      opts.backupPath = `session-backup-${timestamp}.json`;
    }

    try {
      log.info("Starting session data migration", {
        sourceLocation: source.getStorageLocation(),
        targetLocation: target.getStorageLocation(),
        options: opts,
      });

      // Initialize target storage
      await target.initialize();

      // Create backup if requested
      if (opts.createBackup) {
        this.reportProgress(0, 100, "Creating backup");
        const backupSuccess = await this.createBackup(source, opts.backupPath!);
        if (!backupSuccess) {
          throw new Error("Failed to create backup");
        }
      }

      // Read source data
      this.reportProgress(20, 100, "Reading source data");
      const sourceResult = await source.readState();
      if (!sourceResult.success || !sourceResult.data) {
        throw new Error(`Failed to read source data: ${sourceResult.error?.message}`);
      }

      const sourceSessions = sourceResult.data.sessions;
      const totalRecords = sourceSessions.length;

      log.info(`Found ${totalRecords} records to migrate`);

      // Migrate records in batches
      const failedRecords: string[] = [];
      const warnings: string[] = [];
      let migratedCount = 0;

      for (let i = 0; i < sourceSessions.length; i += opts.batchSize) {
        const batch = sourceSessions.slice(i, i + opts.batchSize);
        
        for (const session of batch) {
          try {
            this.reportProgress(migratedCount, totalRecords, "Migrating records", session.session);
            
            // Check if record already exists in target
            const exists = await target.entityExists(session.session);
            if (exists) {
              warnings.push(`Record ${session.session} already exists in target, skipping`);
              continue;
            }

            // Create record in target
            await target.createEntity(session);
            migratedCount++;
            
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            log.error(`Failed to migrate record ${session.session}: ${errorMsg}`);
            failedRecords.push(session.session);
            
            if (opts.stopOnError) {
              throw new Error(`Migration failed on record ${session.session}: ${errorMsg}`);
            }
          }
        }
      }

      // Verify migration if requested
      let verificationResult: VerificationResult | undefined;
      if (opts.verifyAfterMigration) {
        this.reportProgress(95, 100, "Verifying migration");
        verificationResult = await this.verify(source, target);
        
        if (!verificationResult.success) {
          throw new Error("Migration verification failed");
        }
      }

      // Clear source data if requested and migration was successful
      if (opts.clearSourceAfterMigration && failedRecords.length === 0) {
        this.reportProgress(98, 100, "Clearing source data");
        const emptyState: SessionDbState = {
          sessions: [],
          baseDir: sourceResult.data.baseDir,
        };
        await source.writeState(emptyState);
      }

      const duration = Date.now() - startTime;
      this.reportProgress(100, 100, "Migration complete");

      log.info("Migration completed successfully", {
        recordsMigrated: migratedCount,
        failedRecords: failedRecords.length,
        duration,
      });

      return {
        success: true,
        recordsMigrated: migratedCount,
        details: {
          duration,
          sourceLocation: source.getStorageLocation(),
          targetLocation: target.getStorageLocation(),
          failedRecords: failedRecords.length > 0 ? failedRecords : undefined,
          warnings: warnings.length > 0 ? warnings : undefined,
        },
      };

    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      log.error("Migration failed", { error: typedError.message });

      return {
        success: false,
        recordsMigrated: 0,
        error: typedError,
        details: {
          duration: Date.now() - startTime,
          sourceLocation: source.getStorageLocation(),
          targetLocation: target.getStorageLocation(),
        },
      };
    }
  }

  /**
   * Verify that data was migrated correctly
   */
  async verify(
    source: DatabaseStorage<SessionRecord, SessionDbState>,
    target: DatabaseStorage<SessionRecord, SessionDbState>
  ): Promise<VerificationResult> {
    try {
      log.info("Starting migration verification");

      // Read data from both sources
      const [sourceResult, targetResult] = await Promise.all([
        source.readState(),
        target.readState(),
      ]);

      if (!sourceResult.success || !sourceResult.data) {
        throw new Error(`Failed to read source data: ${sourceResult.error?.message}`);
      }

      if (!targetResult.success || !targetResult.data) {
        throw new Error(`Failed to read target data: ${targetResult.error?.message}`);
      }

      const sourceSessions = sourceResult.data.sessions;
      const targetSessions = targetResult.data.sessions;

      // Create maps for efficient lookup
      const sourceMap = new Map(sourceSessions.map(s => [s.session, s]));
      const targetMap = new Map(targetSessions.map(s => [s.session, s]));

      const mismatches: VerificationResult["mismatches"] = [];
      let matchingRecords = 0;

      // Check each source record
      for (const sourceSession of sourceSessions) {
        const targetSession = targetMap.get(sourceSession.session);

        if (!targetSession) {
          mismatches.push({
            recordId: sourceSession.session,
            issue: "missing",
            sourceData: sourceSession,
          });
        } else {
          // Deep compare records
          if (this.recordsEqual(sourceSession, targetSession)) {
            matchingRecords++;
          } else {
            mismatches.push({
              recordId: sourceSession.session,
              issue: "modified",
              sourceData: sourceSession,
              targetData: targetSession,
            });
          }
        }
      }

      const totalRecords = sourceSessions.length;
      const missingRecords = mismatches.filter(m => m.issue === "missing").length;
      const modifiedRecords = mismatches.filter(m => m.issue === "modified").length;

      const success = mismatches.length === 0;

      log.info("Verification completed", {
        success,
        totalRecords,
        matchingRecords,
        missingRecords,
        modifiedRecords,
      });

      return {
        success,
        totalRecords,
        matchingRecords,
        missingRecords,
        modifiedRecords,
        mismatches: mismatches.length > 0 ? mismatches : undefined,
      };

    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      log.error("Verification failed", { error: typedError.message });

      return {
        success: false,
        totalRecords: 0,
        matchingRecords: 0,
        missingRecords: 0,
        modifiedRecords: 0,
        error: typedError,
      };
    }
  }

  /**
   * Create a backup of the source data
   */
  async createBackup(
    source: DatabaseStorage<SessionRecord, SessionDbState>,
    backupPath: string
  ): Promise<boolean> {
    try {
      log.info(`Creating backup at ${backupPath}`);

      // Ensure backup directory exists
      const backupDir = dirname(backupPath);
      if (!existsSync(backupDir)) {
        mkdirSync(backupDir, { recursive: true });
      }

      // Read source data
      const sourceResult = await source.readState();
      if (!sourceResult.success || !sourceResult.data) {
        throw new Error(`Failed to read source data: ${sourceResult.error?.message}`);
      }

      // Write backup file
      const backupData = {
        timestamp: new Date().toISOString(),
        sourceLocation: source.getStorageLocation(),
        data: sourceResult.data,
      };

      await writeFile(backupPath, JSON.stringify(backupData, null, 2), "utf8");
      log.info(`Backup created successfully at ${backupPath}`);

      return true;
    } catch (error) {
      log.error(`Failed to create backup: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Restore data from a backup
   */
  async restoreFromBackup(
    target: DatabaseStorage<SessionRecord, SessionDbState>,
    backupPath: string
  ): Promise<MigrationResult> {
    const startTime = Date.now();

    try {
      log.info(`Restoring from backup: ${backupPath}`);

      // Read backup file
      const backupContent = await readFile(backupPath, "utf8");
      const backupData = JSON.parse(backupContent);

      if (!backupData.data || !backupData.data.sessions) {
        throw new Error("Invalid backup file format");
      }

      // Initialize target storage
      await target.initialize();

      // Restore sessions
      const sessions: SessionRecord[] = backupData.data.sessions;
      const state: SessionDbState = {
        sessions,
        baseDir: backupData.data.baseDir || "/tmp/restored-sessions",
      };

      await target.writeState(state);

      const duration = Date.now() - startTime;
      log.info(`Restore completed: ${sessions.length} records restored`);

      return {
        success: true,
        recordsMigrated: sessions.length,
        details: {
          duration,
          sourceLocation: backupPath,
          targetLocation: target.getStorageLocation(),
        },
      };

    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      log.error(`Restore failed: ${typedError.message}`);

      return {
        success: false,
        recordsMigrated: 0,
        error: typedError,
        details: {
          duration: Date.now() - startTime,
          sourceLocation: backupPath,
          targetLocation: target.getStorageLocation(),
        },
      };
    }
  }

  /**
   * Deep compare two session records
   */
  private recordsEqual(record1: SessionRecord, record2: SessionRecord): boolean {
    return (
      record1.session === record2.session &&
      record1.repoName === record2.repoName &&
      record1.repoUrl === record2.repoUrl &&
      record1.createdAt === record2.createdAt &&
      record1.taskId === record2.taskId &&
      record1.branch === record2.branch &&
      record1.repoPath === record2.repoPath
    );
  }

  /**
   * Report migration progress
   */
  private reportProgress(current: number, total: number, stage: string, recordId?: string): void {
    if (this.progressCallback) {
      this.progressCallback({ current, total, stage, recordId });
    }
  }
}

/**
 * Create a new session migrator instance
 */
export function createSessionMigrator(progressCallback?: MigrationProgressCallback): DataMigrator {
  return new SessionMigrator(progressCallback);
} 

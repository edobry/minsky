/**
 * Migration Service for SessionDB Storage Backends
 *
 * Provides utilities to migrate session data between different storage backends
 * (JSON file, SQLite, PostgreSQL) with backup and verification capabilities.
 */

import { DatabaseStorage } from "../database-storage";
import { SessionRecord, SessionDbState } from "../../session/session-db";
import { StorageBackendFactory } from "../storage-backend-factory";
import { SessionDbConfig } from "../../configuration/types";
import { log } from "../../../utils/logger";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";

export interface MigrationOptions {
  sourceConfig: SessionDbConfig;
  targetConfig: SessionDbConfig;
  backupPath?: string;
  dryRun?: boolean;
  verify?: boolean;
}

export interface MigrationResult {
  success: boolean;
  recordsMigrated: number;
  errors: string[];
  warnings: string[];
  backupPath?: string;
  verificationResult?: VerificationResult;
}

export interface VerificationResult {
  success: boolean;
  sourceCount: number;
  targetCount: number;
  missingRecords: string[];
  inconsistencies: string[];
}

export class MigrationService {
  /**
   * Migrate session data from one backend to another
   */
  static async migrate(options: MigrationOptions): Promise<MigrationResult> {
    const result: MigrationResult = {
      success: false,
      recordsMigrated: 0,
      errors: [],
      warnings: [],
    };

    try {
      log.debug("Starting session database migration", {
        source: options.sourceConfig.backend,
        target: options.targetConfig.backend,
        dryRun: options.dryRun,
      });

      // Create storage backends
      const sourceStorage = StorageBackendFactory.createFromConfig(options.sourceConfig);
      const targetStorage = StorageBackendFactory.createFromConfig(options.targetConfig);

      // Initialize storages
      await sourceStorage.initialize();
      if (!options.dryRun) {
        await targetStorage.initialize();
      }

      // Read source data
      const sourceResult = await sourceStorage.readState();
      if (!sourceResult.success || !sourceResult.data) {
        result.errors.push("Failed to read source database");
        return result;
      }

      const sourceData = sourceResult.data;
      const sessions = sourceData.sessions;

      log.debug(`Found ${sessions.length} sessions to migrate`);

      // Create backup if requested
      if (options.backupPath && !options.dryRun) {
        result.backupPath = await this.createBackup(sourceData, options.backupPath);
        log.debug(`Created backup at: ${result.backupPath}`);
      }

      // Dry run: just validate and report
      if (options.dryRun) {
        result.success = true;
        result.recordsMigrated = sessions.length;
        result.warnings.push(`Dry run: Would migrate ${sessions.length} sessions`);
        log.info("Dry run completed successfully");
        return result;
      }

      // Perform the migration
      let migratedCount = 0;
      for (const session of sessions) {
        try {
          await targetStorage.createEntity(session);
          migratedCount++;
        } catch (error) {
          const errorMsg = `Failed to migrate session ${session.session}: ${error instanceof Error ? error.message : String(error)}`;
          result.errors.push(errorMsg);
          log.error(errorMsg);
        }
      }

      result.recordsMigrated = migratedCount;

      // Verify migration if requested
      if (options.verify) {
        result.verificationResult = await this.verifyMigration(sourceStorage, targetStorage);
        if (!result.verificationResult.success) {
          result.warnings.push("Migration verification found inconsistencies");
        }
      }

      result.success = result.errors.length === 0;

      log.info("Migration completed", {
        success: result.success,
        migrated: result.recordsMigrated,
        errors: result.errors.length,
      });

      return result;
    } catch (error) {
      const errorMsg = `Migration failed: ${error instanceof Error ? error.message : String(error)}`;
      result.errors.push(errorMsg);
      log.error(errorMsg);
      return result;
    }
  }

  /**
   * Create a backup of the source data
   */
  private static async createBackup(data: SessionDbState, backupPath: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFile = join(backupPath, `session-backup-${timestamp}.json`);

    const backupData = {
      timestamp: new Date().toISOString(),
      version: "1.0",
      data,
    };

    writeFileSync(backupFile, JSON.stringify(backupData, null, 2), "utf8");
    return backupFile;
  }

  /**
   * Verify that migration was successful
   */
  private static async verifyMigration(
    sourceStorage: DatabaseStorage<SessionRecord, SessionDbState>,
    targetStorage: DatabaseStorage<SessionRecord, SessionDbState>
  ): Promise<VerificationResult> {
    const verification: VerificationResult = {
      success: true,
      sourceCount: 0,
      targetCount: 0,
      missingRecords: [],
      inconsistencies: [],
    };

    try {
      // Get all sessions from both storages
      const sourceResult = await sourceStorage.readState();
      const targetResult = await targetStorage.readState();

      if (!sourceResult.success || !sourceResult.data) {
        verification.success = false;
        verification.inconsistencies.push("Could not read source data for verification");
        return verification;
      }

      if (!targetResult.success || !targetResult.data) {
        verification.success = false;
        verification.inconsistencies.push("Could not read target data for verification");
        return verification;
      }

      const sourceSessions = sourceResult.data.sessions;
      const targetSessions = targetResult.data.sessions;

      verification.sourceCount = sourceSessions.length;
      verification.targetCount = targetSessions.length;

      // Check for missing records
      for (const sourceSession of sourceSessions) {
        const targetSession = targetSessions.find((s) => s.session === sourceSession.session);
        if (!targetSession) {
          verification.missingRecords.push(sourceSession.session);
          verification.success = false;
        } else {
          // Check for data consistency
          const inconsistencies = this.compareSessionRecords(sourceSession, targetSession);
          if (inconsistencies.length > 0) {
            verification.inconsistencies.push(
              `Session ${sourceSession.session}: ${inconsistencies.join(", ")}`
            );
            verification.success = false;
          }
        }
      }

      // Check for extra records in target
      for (const targetSession of targetSessions) {
        const sourceSession = sourceSessions.find((s) => s.session === targetSession.session);
        if (!sourceSession) {
          verification.inconsistencies.push(`Extra session in target: ${targetSession.session}`);
        }
      }

      return verification;
    } catch (error) {
      verification.success = false;
      verification.inconsistencies.push(
        `Verification failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return verification;
    }
  }

  /**
   * Compare two session records for differences
   */
  private static compareSessionRecords(source: SessionRecord, target: SessionRecord): string[] {
    const differences: string[] = [];

    const fields: (keyof SessionRecord)[] = [
      "session",
      "repoName",
      "repoUrl",
      "createdAt",
      "taskId",
      "branch",
      "repoPath",
    ];

    for (const field of fields) {
      if (source[field] !== target[field]) {
        differences.push(`${field}: '${source[field]}' vs '${target[field]}'`);
      }
    }

    return differences;
  }

  /**
   * Restore from backup
   */
  static async restoreFromBackup(
    backupPath: string,
    targetConfig: SessionDbConfig
  ): Promise<MigrationResult> {
    const result: MigrationResult = {
      success: false,
      recordsMigrated: 0,
      errors: [],
      warnings: [],
    };

    try {
      if (!existsSync(backupPath)) {
        result.errors.push(`Backup file not found: ${backupPath}`);
        return result;
      }

      // Read backup data
      const backupContent = readFileSync(backupPath, "utf8");
      const backupData = JSON.parse(backupContent);

      if (!backupData.data || !backupData.data.sessions) {
        result.errors.push("Invalid backup file format");
        return result;
      }

      log.info(`Restoring from backup: ${backupPath}`, {
        timestamp: backupData.timestamp,
        sessionCount: backupData.data.sessions.length,
      });

      // Create target storage and restore data
      const targetStorage = StorageBackendFactory.createFromConfig(targetConfig);
      await targetStorage.initialize();

      // Clear existing data and restore from backup
      await targetStorage.writeState(backupData.data);

      result.success = true;
      result.recordsMigrated = backupData.data.sessions.length;

      log.info("Restore completed successfully", {
        restored: result.recordsMigrated,
      });

      return result;
    } catch (error) {
      const errorMsg = `Restore failed: ${error instanceof Error ? error.message : String(error)}`;
      result.errors.push(errorMsg);
      log.error(errorMsg);
      return result;
    }
  }

  /**
   * Get migration recommendations based on current setup
   */
  static getMigrationRecommendations(currentConfig: SessionDbConfig): string[] {
    const recommendations: string[] = [];

    switch (currentConfig.backend) {
      case "json":
        recommendations.push(
          "Consider migrating to SQLite for better performance and ACID transactions"
        );
        recommendations.push("SQLite is ideal for single-user development environments");
        if (!currentConfig.baseDir) {
          recommendations.push("Set a baseDir for consistent workspace organization");
        }
        break;

      case "sqlite":
        recommendations.push("Current SQLite setup is good for local development");
        recommendations.push("Consider PostgreSQL for team environments with concurrent access");
        if (!currentConfig.dbPath) {
          recommendations.push("Consider setting a custom dbPath for better organization");
        }
        break;

      case "postgres":
        recommendations.push("PostgreSQL setup is ideal for team/server environments");
        recommendations.push("Ensure connection pooling is configured for production use");
        if (!currentConfig.connectionString) {
          recommendations.push("Connection string must be configured for PostgreSQL");
        }
        break;
    }

    return recommendations;
  }
}

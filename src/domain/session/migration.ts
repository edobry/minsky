/**
 * Session Migration Utility
 * 
 * Safely migrates existing sessions from the old repository-based path structure
 * to the new simplified session-ID-based structure.
 * 
 * OLD: /git/{repo}/sessions/{sessionId}/
 * NEW: /sessions/{sessionId}/
 */

import { join, basename, dirname } from "node:path";
import { mkdir, readdir, access, stat, cp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { log } from "../../utils/logger";

export interface LegacySessionInfo {
  sessionId: string;
  oldPath: string;
  newPath: string;
  repoName: string;
  repoPath: string;
}

export interface MigrationPlan {
  sessions: LegacySessionInfo[];
  backupPath: string;
  totalSessions: number;
}

export interface MigrationResult {
  success: boolean;
  migratedSessions: string[];
  failedSessions: { sessionId: string; error: string }[];
  backupPath: string;
  totalProcessed: number;
}

export interface MigrationOptions {
  dryRun?: boolean;
  baseDir?: string;
  backupEnabled?: boolean;
  progressCallback?: (sessionId: string, index: number, total: number) => void;
}

/**
 * Main migration class for handling session directory migration
 */
export class SessionMigration {
  private baseDir: string;
  private legacyBaseDir: string;
  private newBaseDir: string;

  constructor(baseDir?: string) {
    const xdgStateHome = process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
    this.baseDir = baseDir || join(xdgStateHome, "minsky");
    this.legacyBaseDir = join(this.baseDir, "git");
    this.newBaseDir = join(this.baseDir, "sessions");
  }

  /**
   * Detect all legacy sessions in the old directory structure
   */
  async detectLegacySessions(): Promise<LegacySessionInfo[]> {
    const legacySessions: LegacySessionInfo[] = [];

    try {
      // Check if legacy git directory exists
      if (!existsSync(this.legacyBaseDir)) {
        log.debug("No legacy git directory found");
        return legacySessions;
      }

      // Scan for repository directories in /git/
      const repoDirs = await readdir(this.legacyBaseDir);
      log.debug("Found repository directories");

      for (const repoDir of repoDirs) {
        const repoPath = join(this.legacyBaseDir, repoDir);
        const repoStat = await stat(repoPath);

        if (!repoStat.isDirectory()) {
          continue;
        }

        // Check for sessions directory within repository
        const sessionsPath = join(repoPath, "sessions");
        if (!existsSync(sessionsPath)) {
          continue;
        }

        // Scan for session directories
        const sessionDirs = await readdir(sessionsPath);
        for (const sessionId of sessionDirs) {
          const oldSessionPath = join(sessionsPath, sessionId);
          const sessionStat = await stat(oldSessionPath);

          if (!sessionStat.isDirectory()) {
            continue;
          }

          // Verify it's a valid session directory (contains .git)
          const gitDir = join(oldSessionPath, ".git");
          if (!existsSync(gitDir)) {
            log.warn("Session directory missing .git folder");
            continue;
          }

          const newSessionPath = join(this.newBaseDir, sessionId);
          
          legacySessions.push({
            sessionId,
            oldPath: oldSessionPath,
            newPath: newSessionPath,
            repoName: repoDir,
            repoPath: repoPath
          });
        }
      }

      log.debug("Legacy session detection complete", { 
        count: legacySessions.length,
        sessions: legacySessions.map(s => ({ sessionId: s.sessionId, repoName: s.repoName }))
      });

      return legacySessions;
    } catch (error) {
      log.error("Error detecting legacy sessions", {
        error: error instanceof Error ? error.message : String(error),
        legacyBaseDir: this.legacyBaseDir
      });
      throw error;
    }
  }

  /**
   * Create a migration plan with backup strategy
   */
  async createMigrationPlan(sessions: LegacySessionInfo[]): Promise<MigrationPlan> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(this.baseDir, `migration-backup-${timestamp}`);

    return {
      sessions,
      backupPath,
      totalSessions: sessions.length
    };
  }

  /**
   * Create a backup of the current session structure
   */
  async createBackup(backupPath: string): Promise<void> {
    try {
      log.debug("Creating migration backup", { backupPath });

      // Create backup directory
      await mkdir(backupPath, { recursive: true });

      // Copy entire git directory structure
      if (existsSync(this.legacyBaseDir)) {
        const gitBackupPath = join(backupPath, "git");
        await cp(this.legacyBaseDir, gitBackupPath, { recursive: true });
        log.debug("Legacy git directory backed up", { 
          from: this.legacyBaseDir, 
          to: gitBackupPath 
        });
      }

      // Copy existing sessions directory if it exists
      if (existsSync(this.newBaseDir)) {
        const sessionsBackupPath = join(backupPath, "sessions");
        await cp(this.newBaseDir, sessionsBackupPath, { recursive: true });
        log.debug("Existing sessions directory backed up", { 
          from: this.newBaseDir, 
          to: sessionsBackupPath 
        });
      }

      // Create backup metadata
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const metadata = {
        timestamp: timestamp,
        legacyBaseDir: this.legacyBaseDir,
        newBaseDir: this.newBaseDir,
        backupPath,
        createdAt: new Date().toISOString()
      };

      await writeFile(
        join(backupPath, "backup-metadata.json"),
        JSON.stringify(metadata, null, 2)
      );

      log.debug("Migration backup created successfully", { 
        backupPath, 
        timestamp,
        hasLegacyData: existsSync(this.legacyBaseDir),
        hasExistingSessions: existsSync(this.newBaseDir)
      });
    } catch (error) {
      log.error("Failed to create migration backup", {
        error: error instanceof Error ? error.message : String(error),
        backupPath
      });
      throw error;
    }
  }

  /**
   * Migrate a single session from old to new location
   */
  async migrateSession(session: LegacySessionInfo, dryRun: boolean = false): Promise<void> {
    try {
      log.debug("Migrating session", { 
        sessionId: session.sessionId,
        oldPath: session.oldPath,
        newPath: session.newPath,
        repoName: session.repoName,
        dryRun
      });

      if (dryRun) {
        log.debug("DRY RUN: Would migrate session", { 
          sessionId: session.sessionId,
          wouldCopyFrom: session.oldPath,
          wouldCopyTo: session.newPath
        });
        return;
      }

      // Create parent directory for new session
      await mkdir(dirname(session.newPath), { recursive: true });

      // Check if destination already exists
      if (existsSync(session.newPath)) {
        throw new Error(`Destination already exists: ${session.newPath}`);
      }

      // Copy session directory to new location
      await cp(session.oldPath, session.newPath, { recursive: true });

      // Verify the migration was successful
      await this.verifySessionMigration(session);

      log.info("Session migrated successfully", {
        sessionId: session.sessionId,
        newPath: session.newPath
      });

    } catch (error) {
      log.error("Failed to migrate session", {
        sessionId: session.sessionId,
        error: error instanceof Error ? error.message : String(error),
        oldPath: session.oldPath,
        newPath: session.newPath
      });
      throw error;
    }
  }

  /**
   * Verify that a session was migrated correctly
   */
  private async verifySessionMigration(session: LegacySessionInfo): Promise<void> {
    // Check that new directory exists
    if (!existsSync(session.newPath)) {
      throw new Error(`New session directory not found: ${session.newPath}`);
    }

    // Check that .git directory exists in new location
    const newGitDir = join(session.newPath, ".git");
    if (!existsSync(newGitDir)) {
      throw new Error(`Git directory not found in migrated session: ${newGitDir}`);
    }

    // Verify directory is not empty
    const files = await readdir(session.newPath);
    if (files.length === 0) {
      throw new Error(`Migrated session directory is empty: ${session.newPath}`);
    }

    log.debug("Session migration verified", { 
      sessionId: session.sessionId,
      newPath: session.newPath,
      filesCount: files.length
    });
  }

  /**
   * Execute the full migration process
   */
  async executeMigration(options: MigrationOptions = {}): Promise<MigrationResult> {
    const {
      dryRun = false,
      backupEnabled = true,
      progressCallback
    } = options;

    const result: MigrationResult = {
      success: false,
      migratedSessions: [],
      failedSessions: [],
      backupPath: "",
      totalProcessed: 0
    };

    try {
      log.info("Starting session migration", { dryRun, backupEnabled });

      // Phase 1: Detect legacy sessions
      const legacySessions = await this.detectLegacySessions();
      
      if (legacySessions.length === 0) {
        log.info("No legacy sessions found - migration not needed");
        result.success = true;
        return result;
      }

      // Phase 2: Create migration plan
      const plan = await this.createMigrationPlan(legacySessions);
      result.totalProcessed = plan.totalSessions;

      log.info("Migration plan created", {
        totalSessions: plan.totalSessions,
        sessions: plan.sessions.map(s => s.sessionId)
      });

      // Phase 3: Create backup (if enabled and not dry run)
      if (backupEnabled && !dryRun) {
        await this.createBackup(plan.backupPath);
        result.backupPath = plan.backupPath;
      }

      // Phase 4: Migrate sessions
      for (let i = 0; i < plan.sessions.length; i++) {
        const session = plan.sessions[i];
        
        if (progressCallback) {
          progressCallback(session.sessionId, i + 1, plan.totalSessions);
        }

        try {
          await this.migrateSession(session, dryRun);
          result.migratedSessions.push(session.sessionId);
        } catch (error) {
          result.failedSessions.push({
            sessionId: session.sessionId,
            error: error instanceof Error ? error.message : String(error)
          });
          log.error("Session migration failed", {
            sessionId: session.sessionId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      // Phase 5: Verify overall success
      const successCount = result.migratedSessions.length;
      const failureCount = result.failedSessions.length;
      
      result.success = failureCount === 0;

      log.info("Migration completed", {
        dryRun,
        totalSessions: plan.totalSessions,
        successful: successCount,
        failed: failureCount,
        success: result.success
      });

      return result;

    } catch (error) {
      log.error("Migration process failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Rollback migration using backup
   */
  async rollbackMigration(backupPath: string): Promise<void> {
    try {
      log.info("Starting migration rollback", { backupPath });

      // Verify backup exists
      if (!existsSync(backupPath)) {
        throw new Error(`Backup directory not found: ${backupPath}`);
      }

      // Read backup metadata
      const metadataPath = join(backupPath, "backup-metadata.json");
      if (!existsSync(metadataPath)) {
        throw new Error(`Backup metadata not found: ${metadataPath}`);
      }

      const metadata = JSON.parse(await readFile(metadataPath, "utf-8"));

      // Remove current new sessions directory
      if (existsSync(this.newBaseDir)) {
        await rm(this.newBaseDir, { recursive: true, force: true });
        log.debug("Removed current sessions directory", { path: this.newBaseDir });
      }

      // Restore git directory from backup
      const gitBackupPath = join(backupPath, "git");
      if (existsSync(gitBackupPath)) {
        // Remove current git directory
        if (existsSync(this.legacyBaseDir)) {
          await rm(this.legacyBaseDir, { recursive: true, force: true });
        }

        // Restore from backup
        await cp(gitBackupPath, this.legacyBaseDir, { recursive: true });
        log.debug("Restored git directory from backup", { 
          from: gitBackupPath, 
          to: this.legacyBaseDir 
        });
      }

      // Restore sessions directory from backup if it existed
      const sessionsBackupPath = join(backupPath, "sessions");
      if (existsSync(sessionsBackupPath)) {
        await cp(sessionsBackupPath, this.newBaseDir, { recursive: true });
        log.debug("Restored sessions directory from backup", {
          from: sessionsBackupPath,
          to: this.newBaseDir
        });
      }

      log.info("Migration rollback completed successfully", { backupPath });

    } catch (error) {
      log.error("Migration rollback failed", {
        error: error instanceof Error ? error.message : String(error),
        backupPath
      });
      throw error;
    }
  }

  /**
   * Clean up legacy directories after successful migration
   */
  async cleanupLegacyDirectories(): Promise<void> {
    try {
      log.info("Cleaning up legacy directories", { legacyBaseDir: this.legacyBaseDir });

      if (existsSync(this.legacyBaseDir)) {
        await rm(this.legacyBaseDir, { recursive: true, force: true });
        log.info("Legacy directory cleaned up successfully", { 
          removed: this.legacyBaseDir 
        });
      } else {
        log.info("No legacy directory to clean up");
      }

    } catch (error) {
      log.error("Failed to clean up legacy directories", {
        error: error instanceof Error ? error.message : String(error),
        legacyBaseDir: this.legacyBaseDir
      });
      throw error;
    }
  }
}

/**
 * Convenience function for simple migration execution
 */
export async function migrateSessionsToNewStructure(options: MigrationOptions = {}): Promise<MigrationResult> {
  const migration = new SessionMigration(options.baseDir);
  return migration.executeMigration(options);
}

/**
 * Convenience function for rollback
 */
export async function rollbackSessionMigration(backupPath: string, baseDir?: string): Promise<void> {
  const migration = new SessionMigration(baseDir);
  return migration.rollbackMigration(backupPath);
} 

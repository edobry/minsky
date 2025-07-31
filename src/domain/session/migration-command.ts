import type { SessionProviderInterface, SessionRecord } from "./types";
import {
  SessionMultiBackendIntegration,
  SessionBackwardCompatibility,
  type MultiBackendSessionRecord,
} from "./multi-backend-integration";

/**
 * Migration command options
 */
export interface SessionMigrationOptions {
  /** Preview migration without making changes */
  dryRun?: boolean;
  /** Create backup before migration */
  backup?: boolean;
  /** Skip confirmation prompts */
  force?: boolean;
  /** Number of sessions to process in each batch */
  batchSize?: number;
  /** Show detailed progress information */
  verbose?: boolean;
  /** Filter sessions by criteria */
  filter?: {
    /** Only migrate sessions with specific task backend */
    taskBackend?: string;
    /** Only migrate sessions created before this date */
    createdBefore?: string;
    /** Only migrate sessions matching pattern */
    sessionPattern?: string;
  };
}

/**
 * Migration progress information
 */
export interface MigrationProgress {
  /** Total sessions in database */
  total: number;
  /** Sessions that need migration */
  needsMigration: number;
  /** Sessions already migrated */
  alreadyMigrated: number;
  /** Sessions processed in current run */
  processed: number;
  /** Sessions successfully migrated */
  migrated: number;
  /** Sessions that failed migration */
  failed: number;
  /** Current batch being processed */
  currentBatch: number;
  /** Total batches */
  totalBatches: number;
}

/**
 * Migration result for a single session
 */
export interface SessionMigrationResult {
  /** Original session record */
  original: SessionRecord;
  /** Migrated session record (if successful) */
  migrated?: MultiBackendSessionRecord;
  /** Whether migration was successful */
  success: boolean;
  /** Error message if migration failed */
  error?: string;
  /** Changes made during migration */
  changes: {
    sessionNameChanged: boolean;
    taskIdChanged: boolean;
    backendAdded: boolean;
    legacyIdPreserved: boolean;
  };
}

/**
 * Complete migration report
 */
export interface MigrationReport {
  /** Migration options used */
  options: SessionMigrationOptions;
  /** Final progress statistics */
  progress: MigrationProgress;
  /** Individual session results */
  results: SessionMigrationResult[];
  /** Migration execution time */
  executionTime: number;
  /** Backup file path (if backup was created) */
  backupPath?: string;
  /** Summary of changes made */
  summary: {
    sessionsRenamed: number;
    taskIdsUpgraded: number;
    backendsAdded: number;
    legacyIdsPreserved: number;
  };
}

/**
 * Session database migration service
 */
export class SessionMigrationService {
  constructor(private sessionDB: SessionProviderInterface) {}

  /**
   * Analyze current database and identify migration needs
   */
  async analyzeMigrationNeeds(): Promise<MigrationProgress> {
    const allSessions = await this.sessionDB.listSessions();

    const needsMigration = allSessions.filter((session) =>
      SessionBackwardCompatibility.needsMigration(session)
    );

    const alreadyMigrated = allSessions.filter(
      (session) => !SessionBackwardCompatibility.needsMigration(session) && session.taskId
    );

    return {
      total: allSessions.length,
      needsMigration: needsMigration.length,
      alreadyMigrated: alreadyMigrated.length,
      processed: 0,
      migrated: 0,
      failed: 0,
      currentBatch: 0,
      totalBatches: 0,
    };
  }

  /**
   * Create backup of current session database
   */
  async createBackup(): Promise<string> {
    const allSessions = await this.sessionDB.listSessions();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `session-backup-${timestamp}.json`;

    // In a real implementation, this would write to the actual backup location
    const backupData = {
      timestamp: new Date().toISOString(),
      sessionCount: allSessions.length,
      sessions: allSessions,
      metadata: {
        version: "1.0",
        format: "session-database-backup",
      },
    };

    // TODO: Write to actual file system
    console.log(`Would create backup at: ${backupPath}`);
    console.log(`Backup would contain ${allSessions.length} sessions`);

    return backupPath;
  }

  /**
   * Apply filters to session list
   */
  private applyFilters(
    sessions: SessionRecord[],
    filter?: SessionMigrationOptions["filter"]
  ): SessionRecord[] {
    if (!filter) return sessions;

    let filtered = sessions;

    if (filter.taskBackend) {
      filtered = filtered.filter((session) => {
        const backend = SessionMultiBackendIntegration.getTaskBackend(session);
        return backend === filter.taskBackend;
      });
    }

    if (filter.createdBefore) {
      const cutoffDate = new Date(filter.createdBefore);
      filtered = filtered.filter((session) => {
        const createdDate = new Date(session.createdAt);
        return createdDate < cutoffDate;
      });
    }

    if (filter.sessionPattern) {
      const pattern = new RegExp(filter.sessionPattern);
      filtered = filtered.filter((session) => pattern.test(session.session));
    }

    return filtered;
  }

  /**
   * Migrate a single session record
   */
  private migrateSession(session: SessionRecord): SessionMigrationResult {
    try {
      const enhanced = SessionMultiBackendIntegration.enhanceSessionRecord(session);
      const migrated = SessionMultiBackendIntegration.migrateLegacySessionRecord(session);

      const changes = {
        sessionNameChanged: session.session !== migrated.session,
        taskIdChanged: session.taskId !== migrated.taskId,
        backendAdded: !session.taskId || migrated.taskBackend !== undefined,
        legacyIdPreserved: migrated.legacyTaskId !== undefined,
      };

      return {
        original: session,
        migrated,
        success: true,
        changes,
      };
    } catch (error) {
      return {
        original: session,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        changes: {
          sessionNameChanged: false,
          taskIdChanged: false,
          backendAdded: false,
          legacyIdPreserved: false,
        },
      };
    }
  }

  /**
   * Process sessions in batches
   */
  private async processBatch(
    sessions: SessionRecord[],
    batchSize: number,
    onProgress?: (progress: MigrationProgress) => void
  ): Promise<SessionMigrationResult[]> {
    const results: SessionMigrationResult[] = [];
    const totalBatches = Math.ceil(sessions.length / batchSize);

    for (let i = 0; i < sessions.length; i += batchSize) {
      const batch = sessions.slice(i, i + batchSize);
      const currentBatch = Math.floor(i / batchSize) + 1;

      const batchResults = batch.map((session) => this.migrateSession(session));
      results.push(...batchResults);

      if (onProgress) {
        const progress: MigrationProgress = {
          total: sessions.length,
          needsMigration: sessions.length,
          alreadyMigrated: 0,
          processed: results.length,
          migrated: results.filter((r) => r.success).length,
          failed: results.filter((r) => !r.success).length,
          currentBatch,
          totalBatches,
        };
        onProgress(progress);
      }

      // Small delay between batches to prevent overwhelming the database
      if (i + batchSize < sessions.length) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    return results;
  }

  /**
   * Execute migration with full reporting
   */
  async migrate(
    options: SessionMigrationOptions = {},
    onProgress?: (progress: MigrationProgress) => void
  ): Promise<MigrationReport> {
    const startTime = Date.now();
    const { dryRun = false, backup = true, batchSize = 50, filter } = options;

    // Step 1: Analyze current state
    const initialProgress = await this.analyzeMigrationNeeds();

    // Step 2: Get sessions that need migration
    const allSessions = await this.sessionDB.listSessions();
    const sessionsNeedingMigration = allSessions.filter((session) =>
      SessionBackwardCompatibility.needsMigration(session)
    );

    // Step 3: Apply filters
    const filteredSessions = this.applyFilters(sessionsNeedingMigration, filter);

    if (filteredSessions.length === 0) {
      return {
        options,
        progress: initialProgress,
        results: [],
        executionTime: Date.now() - startTime,
        summary: {
          sessionsRenamed: 0,
          taskIdsUpgraded: 0,
          backendsAdded: 0,
          legacyIdsPreserved: 0,
        },
      };
    }

    // Step 4: Create backup if requested
    let backupPath: string | undefined;
    if (backup && !dryRun) {
      backupPath = await this.createBackup();
    }

    // Step 5: Process sessions
    const results = await this.processBatch(filteredSessions, batchSize, onProgress);

    // Step 6: Apply changes to database (if not dry run)
    if (!dryRun) {
      for (const result of results) {
        if (result.success && result.migrated) {
          try {
            await this.sessionDB.updateSession(result.original.session, result.migrated);
          } catch (error) {
            // Mark this result as failed if database update fails
            result.success = false;
            result.error = `Database update failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
      }
    }

    // Step 7: Generate summary
    const summary = {
      sessionsRenamed: results.filter((r) => r.changes.sessionNameChanged).length,
      taskIdsUpgraded: results.filter((r) => r.changes.taskIdChanged).length,
      backendsAdded: results.filter((r) => r.changes.backendAdded).length,
      legacyIdsPreserved: results.filter((r) => r.changes.legacyIdPreserved).length,
    };

    const finalProgress: MigrationProgress = {
      ...initialProgress,
      processed: results.length,
      migrated: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      totalBatches: Math.ceil(filteredSessions.length / batchSize),
      currentBatch: Math.ceil(filteredSessions.length / batchSize),
    };

    return {
      options,
      progress: finalProgress,
      results,
      executionTime: Date.now() - startTime,
      backupPath,
      summary,
    };
  }

  /**
   * Rollback migration using backup
   */
  async rollback(backupPath: string): Promise<boolean> {
    try {
      // TODO: Implement actual backup restoration
      console.log(`Would restore from backup: ${backupPath}`);
      return true;
    } catch (error) {
      console.error("Rollback failed:", error);
      return false;
    }
  }

  /**
   * Get migration preview without making changes
   */
  async preview(options: SessionMigrationOptions = {}): Promise<MigrationReport> {
    return this.migrate({ ...options, dryRun: true });
  }
}

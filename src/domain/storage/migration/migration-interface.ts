/**
 * Migration Interface Definitions
 *
 * This module defines interfaces and types for migrating data between
 * different storage backends (JSON → SQLite → PostgreSQL).
 */

import type { DatabaseStorage } from "../database-storage";
import type { SessionRecord, SessionDbState } from "../../session/session-db";

/**
 * Migration result information
 */
export interface MigrationResult {
  /**
   * Whether the migration was successful
   */
  success: boolean;
  
  /**
   * Number of records migrated
   */
  recordsMigrated: number;
  
  /**
   * Any error that occurred during migration
   */
  error?: Error;
  
  /**
   * Additional migration details
   */
  details?: {
    /**
     * Time taken for migration (in milliseconds)
     */
    duration: number;
    
    /**
     * Source storage location
     */
    sourceLocation: string;
    
    /**
     * Target storage location
     */
    targetLocation: string;
    
    /**
     * Records that failed to migrate
     */
    failedRecords?: string[];
    
    /**
     * Warnings during migration
     */
    warnings?: string[];
  };
}

/**
 * Migration verification result
 */
export interface VerificationResult {
  /**
   * Whether verification passed
   */
  success: boolean;
  
  /**
   * Total number of records checked
   */
  totalRecords: number;
  
  /**
   * Number of matching records
   */
  matchingRecords: number;
  
  /**
   * Number of missing records
   */
  missingRecords: number;
  
  /**
   * Number of modified records
   */
  modifiedRecords: number;
  
  /**
   * Details of mismatches
   */
  mismatches?: Array<{
    recordId: string;
    issue: 'missing' | 'modified';
    sourceData?: SessionRecord;
    targetData?: SessionRecord;
  }>;
  
  /**
   * Any error that occurred during verification
   */
  error?: Error;
}

/**
 * Migration options
 */
export interface MigrationOptions {
  /**
   * Whether to create a backup before migration
   */
  createBackup?: boolean;
  
  /**
   * Path for backup file (if creating backup)
   */
  backupPath?: string;
  
  /**
   * Whether to verify data after migration
   */
  verifyAfterMigration?: boolean;
  
  /**
   * Whether to clear source data after successful migration
   */
  clearSourceAfterMigration?: boolean;
  
  /**
   * Maximum number of records to migrate in a single batch
   */
  batchSize?: number;
  
  /**
   * Whether to stop on first error or continue with remaining records
   */
  stopOnError?: boolean;
}

/**
 * Interface for data migration between storage backends
 */
export interface DataMigrator {
  /**
   * Migrate data from source to target storage
   */
  migrate(
    source: DatabaseStorage<SessionRecord, SessionDbState>,
    target: DatabaseStorage<SessionRecord, SessionDbState>,
    options?: MigrationOptions
  ): Promise<MigrationResult>;
  
  /**
   * Verify that data was migrated correctly
   */
  verify(
    source: DatabaseStorage<SessionRecord, SessionDbState>,
    target: DatabaseStorage<SessionRecord, SessionDbState>
  ): Promise<VerificationResult>;
  
  /**
   * Create a backup of the source data
   */
  createBackup(
    source: DatabaseStorage<SessionRecord, SessionDbState>,
    backupPath: string
  ): Promise<boolean>;
  
  /**
   * Restore data from a backup
   */
  restoreFromBackup(
    target: DatabaseStorage<SessionRecord, SessionDbState>,
    backupPath: string
  ): Promise<MigrationResult>;
}

/**
 * Progress callback for migration operations
 */
export type MigrationProgressCallback = (progress: {
  current: number;
  total: number;
  stage: string;
  recordId?: string;
}) => void; 

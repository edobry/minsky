/**
 * Backend Migration Utilities
 * 
 * Provides functionality to migrate tasks between different task backends
 * while preserving data integrity and handling edge cases gracefully.
 */

import type { TaskBackend } from "./taskBackend";
import type { TaskData } from "../../types/tasks/taskData";
import { log } from "../../utils/logger";

/**
 * Configuration options for task migration
 */
export interface MigrationOptions {
  /** Whether to preserve task IDs during migration */
  preserveIds?: boolean;
  /** Perform a dry run without making changes */
  dryRun?: boolean;
  /** Custom status mapping between backends */
  statusMapping?: Record<string, string>;
  /** Whether to rollback on failure */
  rollbackOnFailure?: boolean;  
  /** Strategy for handling ID conflicts */
  idConflictStrategy?: "skip" | "rename" | "overwrite";
  /** Create backup before migration */
  createBackup?: boolean;
  /** Custom backup directory */
  backupDir?: string;
}

/**
 * Result of a migration operation
 */
export interface MigrationResult {
  success: boolean;
  migratedCount: number;
  skippedCount: number;
  errors: string[];
  backupPath?: string;
}

/**
 * Backup data for rollback operations
 */
export interface BackupData {
  timestamp: string;
  sourceBackend: string;
  targetBackend: string;
  originalData: string;
  backupPath: string;
}

/**
 * Core migration utilities for task backends
 */
export class BackendMigrationUtils {
  /**
   * Migrate tasks between different backends
   */
  async migrateTasksBetweenBackends(
    sourceBackend: TaskBackend,
    targetBackend: TaskBackend,
    options: MigrationOptions = {}
  ): Promise<MigrationResult> {
    const {
      preserveIds = true,
      dryRun = false,
      statusMapping = {},
      rollbackOnFailure = true,
      idConflictStrategy = "skip",
      createBackup = true,
    } = options;

    log.agent("Starting task migration", {
      from: sourceBackend.name,
      to: targetBackend.name,
      options,
    });

    let backupData: BackupData | null = null;
    const result: MigrationResult = {
      success: false,
      migratedCount: 0,
      skippedCount: 0,
      errors: [],
    };

    try {
      // Pre-flight validation
      await this.validateMigration(sourceBackend, targetBackend);

      // Create backup if requested
      if (createBackup && !dryRun) {
        backupData = await this.createBackupBeforeMigration(targetBackend);
        result.backupPath = backupData.backupPath;
      }

      // Get source tasks
      const sourceDataResult = await sourceBackend.getTasksData();
      if (!sourceDataResult.success || !sourceDataResult.content) {
        throw new Error("Failed to get source tasks data");
      }
      const sourceTasks = sourceBackend.parseTasks(sourceDataResult.content);

      // Get target tasks to check for conflicts
      const targetDataResult = await targetBackend.getTasksData();
      if (!targetDataResult.success || !targetDataResult.content) {
        throw new Error("Failed to get target tasks data");
      }
      const targetTasks = targetBackend.parseTasks(targetDataResult.content);

      // Resolve ID conflicts and transform tasks
      const transformedTasks = await this.transformTasks(
        sourceTasks,
        targetTasks,
        sourceBackend,
        targetBackend,
        {
          preserveIds,
          statusMapping,
          idConflictStrategy,
        }
      );

      // Apply transformations if not dry run
      if (!dryRun) {
        const formattedData = targetBackend.formatTasks(transformedTasks.migrated);
        await targetBackend.saveTasksData(formattedData);
      }

      result.success = true;
      result.migratedCount = transformedTasks.migrated.length;
      result.skippedCount = transformedTasks.skipped.length;

      log.agent("Migration completed successfully", {
        migratedCount: result.migratedCount,
        skippedCount: result.skippedCount,
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      result.errors.push(errorMessage);
      log.error("Migration failed", { error: errorMessage });

      // Attempt rollback if requested and backup exists
      if (rollbackOnFailure && backupData && !dryRun) {
        try {
          await this.rollbackMigration(backupData, targetBackend);
          log.agent("Rollback completed successfully");
        } catch (rollbackError) {
          const rollbackMessage = rollbackError instanceof Error 
            ? rollbackError.message 
            : "Unknown rollback error";
          result.errors.push(`Rollback failed: ${rollbackMessage}`);
          log.error("Rollback failed", { error: rollbackMessage });
        }
      }
    }

    return result;
  }

  /**
   * Validate that migration can proceed between backends
   */
  async validateMigration(
    sourceBackend: TaskBackend,
    targetBackend: TaskBackend
  ): Promise<void> {
    // Check that backends are different
    if (sourceBackend.name === targetBackend.name) {
      throw new Error("Source and target backends cannot be the same");
    }

    // Validate source backend has data
    try {
      await sourceBackend.getTasksData();
    } catch (error) {
      throw new Error(`Cannot access source backend: ${error}`);
    }

    // Validate target backend is writable
    try {
      const testData = targetBackend.formatTasks([]);
      await targetBackend.saveTasksData(testData);
    } catch (error) {
      throw new Error(`Cannot write to target backend: ${error}`);
    }
  }

  /**
   * Create backup before migration
   */
  async createBackupBeforeMigration(backend: TaskBackend): Promise<BackupData> {
    const timestamp = new Date().toISOString();
    const backupPath = `migration-backup-${backend.name}-${timestamp}`;
    
    const dataResult = await backend.getTasksData();
    if (!dataResult.success || !dataResult.content) {
      throw new Error("Failed to get data for backup");
    }
    
    const backupData: BackupData = {
      timestamp,
      sourceBackend: backend.name,
      targetBackend: backend.name,
      originalData: dataResult.content,
      backupPath,
    };

    // In a real implementation, we would save this to disk
    // For now, we'll keep it in memory
    return backupData;
  }

  /**
   * Rollback migration using backup data
   */
  async rollbackMigration(
    backupData: BackupData,
    targetBackend: TaskBackend
  ): Promise<void> {
    log.agent("Starting migration rollback", {
      targetBackend: backupData.targetBackend,
      timestamp: backupData.timestamp,
    });

    await targetBackend.saveTasksData(backupData.originalData);
    
    log.agent("Migration rollback completed successfully");
  }

  /**
   * Transform tasks from source to target format
   */
  private async transformTasks(
    sourceTasks: TaskData[],
    targetTasks: TaskData[],
    sourceBackend: TaskBackend,
    targetBackend: TaskBackend,
    options: {
      preserveIds: boolean;
      statusMapping: Record<string, string>;
      idConflictStrategy: "skip" | "rename" | "overwrite";
    }
  ): Promise<{ migrated: TaskData[]; skipped: TaskData[] }> {
    const migrated: TaskData[] = [];
    const skipped: TaskData[] = [];
    const targetIds = new Set(targetTasks.map(t => t.id));

    for (const task of sourceTasks) {
      try {
        // Handle ID conflicts
        let finalTask = { ...task };
        
        if (options.preserveIds && targetIds.has(task.id)) {
          switch (options.idConflictStrategy) {
          case "skip":
            skipped.push(task);
            continue;
          case "rename":
            finalTask.id = await this.generateUniqueId(task.id, targetIds);
            break;
          case "overwrite":
            // Keep original ID, will overwrite
            break;
          }
        }

        // Map status between backends
        finalTask.status = this.mapTaskStatus(
          task.status,
          sourceBackend.name,
          targetBackend.name,
          options.statusMapping
        );

        migrated.push(finalTask);
        targetIds.add(finalTask.id);
      } catch (error) {
        log.warn("Failed to transform task", { taskId: task.id, error });
        skipped.push(task);
      }
    }

    return { migrated, skipped };
  }

  /**
   * Map task status between backends
   */
  mapTaskStatus(
    status: string,
    fromBackend: string,
    toBackend: string,
    customMapping?: Record<string, string>
  ): string {
    // Use custom mapping first
    if (customMapping && customMapping[status]) {
      return customMapping[status];
    }

    // Default status mappings between backends
    const defaultMappings: Record<string, Record<string, string>> = {
      "markdown->github-issues": {
        "TODO": "minsky:todo",
        "IN-PROGRESS": "minsky:in-progress", 
        "IN-REVIEW": "minsky:in-review",
        "DONE": "minsky:done",
      },
      "github-issues->markdown": {
        "minsky:todo": "TODO",
        "minsky:in-progress": "IN-PROGRESS",
        "minsky:in-review": "IN-REVIEW", 
        "minsky:done": "DONE",
      },
    };

    const mappingKey = `${fromBackend}->${toBackend}`;
    const mapping = defaultMappings[mappingKey];
    
    return mapping?.[status] || status;
  }

  /**
   * Generate a unique ID when conflicts occur
   */
  private async generateUniqueId(baseId: string, existingIds: Set<string>): Promise<string> {
    let counter = 1;
    let newId = `${baseId}-migrated-${counter}`;
    
    while (existingIds.has(newId)) {
      counter++;
      newId = `${baseId}-migrated-${counter}`;
    }
    
    return newId;
  }

  /**
   * Perform a dry run to preview migration results
   */
  async performDryRun(
    sourceBackend: TaskBackend,
    targetBackend: TaskBackend,
    options: MigrationOptions
  ): Promise<MigrationResult> {
    return this.migrateTasksBetweenBackends(sourceBackend, targetBackend, {
      ...options,
      dryRun: true,
      createBackup: false,
    });
  }
} 

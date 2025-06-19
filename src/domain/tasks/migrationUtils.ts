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
  /** Whether to create backup before migration */
  createBackup?: boolean;
}

/**
 * Result of a migration operation
 */
export interface MigrationResult {
  success: boolean;
  migratedCount: number;
  skippedCount: number;
  errors: string[];
  backupData?: any;
  summary: string;
}

/**
 * Backup data structure for rollback operations
 */
interface BackupData {
  timestamp: string;
  sourceBackend: string;
  targetBackend: string;
  originalTargetTasks: TaskData[];
  migratedTasks: TaskData[];
}

/**
 * Default status mappings between backends
 */
const DEFAULT_STATUS_MAPPINGS: Record<string, Record<string, string>> = {
  "markdown->github-issues": {
    TODO: "minsky:todo",
    "IN-PROGRESS": "minsky:in-progress",
    "IN-REVIEW": "minsky:in-review",
    DONE: "minsky:done",
  },
  "github-issues->markdown": {
    "minsky:todo": "TODO",
    "minsky:in-progress": "IN-PROGRESS",
    "minsky:in-review": "IN-REVIEW",
    "minsky:done": "DONE",
  },
  "json-file->markdown": {
    TODO: "TODO",
    "IN-PROGRESS": "IN-PROGRESS",
    "IN-REVIEW": "IN-REVIEW",
    DONE: "DONE",
  },
  "markdown->json-file": {
    TODO: "TODO",
    "IN-PROGRESS": "IN-PROGRESS",
    "IN-REVIEW": "IN-REVIEW",
    DONE: "DONE",
  },
};

/**
 * BackendMigrationUtils provides functionality to migrate tasks between different backends
 */
export class BackendMigrationUtils {
  /**
   * Migrate tasks from one backend to another
   * @param sourceBackend Source task backend
   * @param targetBackend Target task backend
   * @param options Migration options
   * @returns Promise resolving to migration result
   */
  async migrateTasksBetweenBackends(
    sourceBackend: TaskBackend,
    targetBackend: TaskBackend,
    options: MigrationOptions = {}
  ): Promise<MigrationResult> {
    const {
      preserveIds = false,
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

    const result: MigrationResult = {
      success: false,
      migratedCount: 0,
      skippedCount: 0,
      errors: [],
      summary: "",
    };

    let backupData: BackupData | null = null;

    try {
      // Step 1: Validate migration is possible
      await this.validateMigration(sourceBackend, targetBackend);

      // Step 2: Create backup if requested
      if (createBackup && !dryRun) {
        backupData = await this.createBackupBeforeMigration(sourceBackend, targetBackend);
        result.backupData = backupData;
      }

      // Step 3: Read tasks from source backend
      const sourceResult = await sourceBackend.getTasksData();
      if (!sourceResult.success || !sourceResult.content) {
        throw new Error(`Failed to read tasks from source backend: ${sourceResult.error?.message}`);
      }

      const sourceTasks = sourceBackend.parseTasks(sourceResult.content);
      log.debug(`Retrieved ${sourceTasks.length} tasks from source backend`);

      if (sourceTasks.length === 0) {
        result.success = true;
        result.summary = "No tasks found in source backend to migrate";
        return result;
      }

      // Step 4: Read existing tasks from target backend
      const targetResult = await targetBackend.getTasksData();
      let existingTargetTasks: TaskData[] = [];
      if (targetResult.success && targetResult.content) {
        existingTargetTasks = targetBackend.parseTasks(targetResult.content);
      }

      // Step 5: Transform and prepare tasks for migration
      const { tasksToMigrate, conflicts } = await this.prepareTasksForMigration(
        sourceTasks,
        existingTargetTasks,
        sourceBackend,
        targetBackend,
        { preserveIds, statusMapping, idConflictStrategy }
      );

      result.skippedCount = conflicts.length;
      if (conflicts.length > 0) {
        result.errors.push(...conflicts.map((c) => `ID conflict: ${c.id} - ${c.reason}`));
      }

      // Step 6: Perform dry run or actual migration
      if (dryRun) {
        result.success = true;
        result.migratedCount = tasksToMigrate.length;
        result.summary = `Dry run complete: ${tasksToMigrate.length} tasks would be migrated, ${conflicts.length} skipped`;
        return result;
      }

      // Step 7: Execute the migration
      await this.executeMigration(targetBackend, existingTargetTasks, tasksToMigrate);

      result.success = true;
      result.migratedCount = tasksToMigrate.length;
      result.summary = `Successfully migrated ${tasksToMigrate.length} tasks from ${sourceBackend.name} to ${targetBackend.name}`;

      log.agent("Migration completed successfully", {
        migratedCount: result.migratedCount,
        skippedCount: result.skippedCount,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.errors.push(errorMessage);
      result.summary = `Migration failed: ${errorMessage}`;

      log.error("Migration failed", { error: errorMessage });

      // Attempt rollback if enabled
      if (rollbackOnFailure && backupData && !dryRun) {
        try {
          await this.rollbackMigration(backupData, targetBackend);
          result.summary += " (rollback completed)";
          log.agent("Rollback completed successfully");
        } catch (rollbackError) {
          const rollbackErrorMessage =
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          result.errors.push(`Rollback failed: ${rollbackErrorMessage}`);
          result.summary += " (rollback failed)";
          log.error("Rollback failed", { error: rollbackErrorMessage });
        }
      }
    }

    return result;
  }

  /**
   * Validate that migration between backends is possible
   * @param sourceBackend Source backend
   * @param targetBackend Target backend
   */
  private async validateMigration(
    sourceBackend: TaskBackend,
    targetBackend: TaskBackend
  ): Promise<void> {
    if (sourceBackend.name === targetBackend.name) {
      throw new Error("Source and target backends cannot be the same");
    }

    // Test that we can read from source
    const sourceTest = await sourceBackend.getTasksData();
    if (!sourceTest.success) {
      throw new Error(
        `Cannot read from source backend ${sourceBackend.name}: ${sourceTest.error?.message}`
      );
    }

    // Test that we can write to target (by reading first - write test would be destructive)
    const targetTest = await targetBackend.getTasksData();
    if (!targetTest.success && targetTest.error?.message?.includes("permission")) {
      throw new Error(`Cannot write to target backend ${targetBackend.name}: permission denied`);
    }
  }

  /**
   * Create backup of current state before migration
   * @param sourceBackend Source backend
   * @param targetBackend Target backend
   * @returns Backup data
   */
  private async createBackupBeforeMigration(
    sourceBackend: TaskBackend,
    targetBackend: TaskBackend
  ): Promise<BackupData> {
    log.debug("Creating backup before migration");

    // Get current target backend tasks for rollback
    const targetResult = await targetBackend.getTasksData();
    const originalTargetTasks: TaskData[] = [];
    if (targetResult.success && targetResult.content) {
      originalTargetTasks.push(...targetBackend.parseTasks(targetResult.content));
    }

    return {
      timestamp: new Date().toISOString(),
      sourceBackend: sourceBackend.name,
      targetBackend: targetBackend.name,
      originalTargetTasks,
      migratedTasks: [], // Will be populated during migration
    };
  }

  /**
   * Prepare tasks for migration by transforming and resolving conflicts
   * @param sourceTasks Tasks from source backend
   * @param existingTargetTasks Existing tasks in target backend
   * @param sourceBackend Source backend
   * @param targetBackend Target backend
   * @param options Migration options
   * @returns Tasks to migrate and conflicts
   */
  private async prepareTasksForMigration(
    sourceTasks: TaskData[],
    existingTargetTasks: TaskData[],
    sourceBackend: TaskBackend,
    targetBackend: TaskBackend,
    options: {
      preserveIds: boolean;
      statusMapping: Record<string, string>;
      idConflictStrategy: "skip" | "rename" | "overwrite";
    }
  ): Promise<{ tasksToMigrate: TaskData[]; conflicts: Array<{ id: string; reason: string }> }> {
    const tasksToMigrate: TaskData[] = [];
    const conflicts: Array<{ id: string; reason: string }> = [];

    for (const sourceTask of sourceTasks) {
      try {
        // Transform the task for the target backend
        const transformedTask = await this.transformTaskForBackend(
          sourceTask,
          sourceBackend,
          targetBackend,
          options.statusMapping
        );

        // Handle ID conflicts
        const existingTask = existingTargetTasks.find((t) => t.id === transformedTask.id);
        if (existingTask) {
          switch (options.idConflictStrategy) {
          case "skip":
            conflicts.push({
              id: transformedTask.id,
              reason: "Task already exists in target backend",
            });
            continue;
          case "overwrite":
            // Allow overwrite by continuing with migration
            break;
          case "rename":
            // Generate new ID
            transformedTask.id = await this.generateUniqueTaskId(
              existingTargetTasks,
              transformedTask.id
            );
            break;
          }
        }

        tasksToMigrate.push(transformedTask);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        conflicts.push({ id: sourceTask.id, reason: `Transformation failed: ${errorMessage}` });
      }
    }

    return { tasksToMigrate, conflicts };
  }

  /**
   * Transform a task for a specific backend
   * @param task Task to transform
   * @param sourceBackend Source backend
   * @param targetBackend Target backend
   * @param statusMapping Custom status mapping
   * @returns Transformed task
   */
  private async transformTaskForBackend(
    task: TaskData,
    sourceBackend: TaskBackend,
    targetBackend: TaskBackend,
    statusMapping: Record<string, string>
  ): Promise<TaskData> {
    const transformedTask: TaskData = { ...task };

    // Transform status
    transformedTask.status = this.mapTaskStatus(
      task.status,
      sourceBackend.name,
      targetBackend.name,
      statusMapping
    );

    // Update spec path for target backend
    transformedTask.specPath = targetBackend.getTaskSpecPath(task.id, task.title);

    return transformedTask;
  }

  /**
   * Map task status between backends
   * @param status Original status
   * @param sourceBackendName Source backend name
   * @param targetBackendName Target backend name
   * @param customMapping Custom mapping overrides
   * @returns Mapped status
   */
  private mapTaskStatus(
    status: string,
    sourceBackendName: string,
    targetBackendName: string,
    customMapping?: Record<string, string>
  ): string {
    // Check custom mapping first
    if (customMapping && customMapping[status]) {
      return customMapping[status];
    }

    // Use default mapping
    const mappingKey = `${sourceBackendName}->${targetBackendName}`;
    const defaultMapping = DEFAULT_STATUS_MAPPINGS[mappingKey];

    if (defaultMapping && defaultMapping[status]) {
      return defaultMapping[status];
    }

    // Fallback to original status
    return status;
  }

  /**
   * Generate a unique task ID to avoid conflicts
   * @param existingTasks Existing tasks in target backend
   * @param preferredId Preferred ID
   * @returns Unique task ID
   */
  private async generateUniqueTaskId(
    existingTasks: TaskData[],
    preferredId: string
  ): Promise<string> {
    let counter = 1;
    let newId = `${preferredId}-migrated`;

    while (existingTasks.some((t) => t.id === newId)) {
      newId = `${preferredId}-migrated-${counter}`;
      counter++;
    }

    return newId;
  }

  /**
   * Execute the migration by saving tasks to target backend
   * @param targetBackend Target backend
   * @param existingTasks Existing tasks in target backend
   * @param tasksToMigrate Tasks to migrate
   */
  private async executeMigration(
    targetBackend: TaskBackend,
    existingTasks: TaskData[],
    tasksToMigrate: TaskData[]
  ): Promise<void> {
    // Combine existing tasks with migrated tasks
    const allTasks = [...existingTasks, ...tasksToMigrate];

    // Format and save to target backend
    const formattedContent = targetBackend.formatTasks(allTasks);
    const saveResult = await targetBackend.saveTasksData(formattedContent);

    if (!saveResult.success) {
      throw new Error(`Failed to save tasks to target backend: ${saveResult.error?.message}`);
    }

    log.debug(`Successfully migrated ${tasksToMigrate.length} tasks to ${targetBackend.name}`);
  }

  /**
   * Rollback migration by restoring original state
   * @param backupData Backup data from before migration
   * @param targetBackend Target backend to rollback
   */
  private async rollbackMigration(
    backupData: BackupData,
    targetBackend: TaskBackend
  ): Promise<void> {
    log.agent("Starting migration rollback", {
      targetBackend: backupData.targetBackend,
      timestamp: backupData.timestamp,
    });

    // Restore original tasks in target backend
    const formattedContent = targetBackend.formatTasks(backupData.originalTargetTasks);
    const saveResult = await targetBackend.saveTasksData(formattedContent);

    if (!saveResult.success) {
      throw new Error(`Failed to rollback tasks: ${saveResult.error?.message}`);
    }

    log.agent("Migration rollback completed successfully");
  }

  /**
   * Perform a dry run to preview migration results
   * @param sourceBackend Source backend
   * @param targetBackend Target backend
   * @param options Migration options
   * @returns Promise resolving to dry run results
   */
  async performDryRun(
    sourceBackend: TaskBackend,
    targetBackend: TaskBackend,
    options: MigrationOptions = {}
  ): Promise<MigrationResult> {
    return this.migrateTasksBetweenBackends(sourceBackend, targetBackend, {
      ...options,
      dryRun: true,
    });
  }
}

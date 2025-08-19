/**
 * Task Migration Service
 *
 * Provides utilities to migrate legacy task IDs (#123) to qualified format (md#123)
 * with safety features including dry-run, backup, and rollback capabilities.
 */

import { promises as fs } from "fs";
import { join, dirname } from "path";
import { log } from "../../utils/logger";
import { validateQualifiedTaskId, getTaskIdNumber } from "./task-id-utils";
import { getTasksFilePath, getTaskSpecsDirectoryPath, listFiles } from "./taskIO";

export interface MigrationOptions {
  /** Show what would be changed without making changes */
  dryRun?: boolean;
  /** Target backend for migration (default: "md") */
  toBackend?: string;
  /** Filter tasks by status (e.g., "TODO", "IN-PROGRESS") */
  statusFilter?: string;
  /** Create backup before migration */
  createBackup?: boolean;
  /** Force migration even if some tasks might be lost */
  force?: boolean;
}

export interface MigrationResult {
  /** Total tasks processed */
  totalTasks: number;
  /** Tasks that were migrated */
  migratedTasks: number;
  /** Tasks that were already qualified */
  alreadyQualified: number;
  /** Tasks that couldn't be migrated */
  failedTasks: number;
  /** Backup file path if created */
  backupPath?: string;
  /** Detailed migration log */
  details: MigrationDetail[];
}

export interface MigrationDetail {
  /** Original task ID */
  originalId: string;
  /** New qualified ID */
  newId?: string;
  /** Migration status */
  status: "migrated" | "already-qualified" | "failed" | "skipped";
  /** Reason for failure or skipping */
  reason?: string;
  /** Task title for context */
  title?: string;
}

export class TaskMigrationService {
  private workspacePath: string;
  private tasksFilePath: string;
  private tasksDirPath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.tasksFilePath = getTasksFilePath(workspacePath);
    this.tasksDirPath = getTaskSpecsDirectoryPath(workspacePath);
  }

  /**
   * Migrate legacy task IDs to qualified format
   */
  async migrateTaskIds(options: MigrationOptions = {}): Promise<MigrationResult> {
    const {
      dryRun = false,
      toBackend = "md",
      statusFilter,
      createBackup = true,
      force = false,
    } = options;

    log.info("Starting task ID migration", {
      dryRun,
      toBackend,
      statusFilter,
      createBackup,
      force,
    });

    const result: MigrationResult = {
      totalTasks: 0,
      migratedTasks: 0,
      alreadyQualified: 0,
      failedTasks: 0,
      details: [],
    };

    // 1) Read and backup central tasks file
    const tasksContent = await fs.readFile(this.tasksFilePath, "utf-8");
    if (createBackup && !dryRun) {
      result.backupPath = await this.createBackup(tasksContent);
      log.info("Created backup", { backupPath: result.backupPath });
    }

    // 2) Migrate task IDs in central tasks file
    const { migratedContent, migrationDetails } = await this.processTasksContent(
      tasksContent,
      toBackend,
      statusFilter,
      force
    );

    result.details = migrationDetails;
    result.totalTasks = migrationDetails.length;
    result.migratedTasks = migrationDetails.filter((d) => d.status === "migrated").length;
    result.alreadyQualified = migrationDetails.filter(
      (d) => d.status === "already-qualified"
    ).length;
    result.failedTasks = migrationDetails.filter((d) => d.status === "failed").length;

    if (!dryRun && result.migratedTasks > 0) {
      await fs.writeFile(this.tasksFilePath, migratedContent, "utf-8");
      log.info("Updated process/tasks.md with qualified IDs");
    }

    // 3) Rename spec files: numeric prefix → qualified prefix (md#<id>-...)
    await this.renameSpecFiles(toBackend, { dryRun });

    return result;
  }

  /**
   * Process tasks content and migrate legacy IDs
   */
  private async processTasksContent(
    content: string,
    toBackend: string,
    statusFilter?: string,
    force: boolean = false
  ): Promise<{ migratedContent: string; migrationDetails: MigrationDetail[] }> {
    const lines = content.split("\n");
    const migrationDetails: MigrationDetail[] = [];
    const migratedLines: string[] = [];

    for (const line of lines) {
      // Check if line contains a task
      const taskMatch = line.match(/^(\s*-\s*\[([x ])\]\s*)(.+?)\s*\[([^\]]+)\]/);

      if (taskMatch) {
        const [, prefix, checkbox, title, taskIdWithBrackets] = taskMatch;
        const taskId = taskIdWithBrackets;

        // Extract task status from checkbox and title
        const status = checkbox === "x" ? "DONE" : "TODO"; // Simplified status detection

        // Apply status filter if specified
        if (statusFilter && status !== statusFilter) {
          migrationDetails.push({
            originalId: taskId,
            status: "skipped",
            reason: `Status ${status} doesn't match filter ${statusFilter}`,
            title: title.trim(),
          });
          migratedLines.push(line);
          continue;
        }

        // Check if already qualified
        if (this.isQualifiedId(taskId)) {
          migrationDetails.push({
            originalId: taskId,
            status: "already-qualified",
            title: title.trim(),
          });
          migratedLines.push(line);
          continue;
        }

        // Try to migrate legacy ID
        const migratedId = this.migrateLegacyId(taskId, toBackend);

        if (migratedId) {
          const newLine = line.replace(`[${taskId}]`, `[${migratedId}]`);
          migrationDetails.push({
            originalId: taskId,
            newId: migratedId,
            status: "migrated",
            title: title.trim(),
          });
          migratedLines.push(newLine);
        } else {
          migrationDetails.push({
            originalId: taskId,
            status: "failed",
            reason: "Could not parse legacy ID",
            title: title.trim(),
          });
          migratedLines.push(line);
        }
      } else {
        // Non-task line, keep as-is
        migratedLines.push(line);
      }
    }

    return {
      migratedContent: migratedLines.join("\n"),
      migrationDetails,
    };
  }

  /**
   * Rename spec files from numeric to qualified prefix (md#<id>-...)
   * Uses conservative operations with backups to avoid data loss.
   */
  private async renameSpecFiles(backendPrefix: string, opts: { dryRun: boolean }): Promise<void> {
    const files = (await listFiles(this.tasksDirPath)) || [];
    const candidates = files.filter((f) => /^\d+-.*\.md$/.test(f));

    if (candidates.length === 0) return;

    // Create a backup directory snapshot (copy) when not dry-run
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = join(this.tasksDirPath, `backup-${timestamp}`);

    if (!opts.dryRun) {
      try {
        await fs.mkdir(backupDir, { recursive: true });
        // Copy candidate files into backup dir
        for (const f of candidates) {
          const src = join(this.tasksDirPath, f);
          const dest = join(backupDir, f);
          await fs.copyFile(src, dest);
        }
        log.info("Created spec files backup", { backupDir, count: candidates.length });
      } catch (error) {
        log.error("Failed to create spec files backup", { error });
        throw error;
      }
    }

    // Perform renames
    for (const f of candidates) {
      const match = f.match(/^(\d+)-(.*\.md)$/);
      if (!match) continue;
      const [, idNum, rest] = match;
      const newName = `${backendPrefix}#${idNum}-${rest}`;

      const oldPath = join(this.tasksDirPath, f);
      const newPath = join(this.tasksDirPath, newName);

      if (opts.dryRun) {
        log.cli(`DRY RUN: would rename ${f} → ${newName}`);
        continue;
      }

      try {
        // Ensure destination does not exist to avoid overwriting
        try {
          await fs.access(newPath);
          throw new Error(`Destination already exists: ${newName}`);
        } catch {
          // ok if not exists
        }

        await fs.rename(oldPath, newPath);
        log.cli(`Renamed ${f} → ${newName}`);
      } catch (error) {
        log.error("Failed to rename spec file", { from: f, to: newName, error });
        // On error, leave the original file in place (backup allows recovery)
        continue;
      }
    }
  }

  /**
   * Check if task ID is already qualified
   */
  private isQualifiedId(taskId: string): boolean {
    return /^[a-zA-Z]+#\d+$/.test(taskId);
  }

  /**
   * Migrate a legacy ID to qualified format
   */
  private migrateLegacyId(taskId: string, toBackend: string): string | null {
    // Handle #123 format
    if (taskId.startsWith("#")) {
      const numericPart = taskId.slice(1);
      if (/^\d+$/.test(numericPart)) {
        return `${toBackend}#${numericPart}`;
      }
    }

    // Handle plain numeric format (shouldn't appear in brackets but just in case)
    if (/^\d+$/.test(taskId)) {
      return `${toBackend}#${taskId}`;
    }

    return null;
  }

  /**
   * Create backup of tasks file
   */
  private async createBackup(content: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(this.workspacePath, "process", `tasks-backup-${timestamp}.md`);

    await fs.writeFile(backupPath, content, "utf-8");
    return backupPath;
  }

  /**
   * Restore from backup
   */
  async restoreFromBackup(backupPath: string): Promise<void> {
    const backupContent = await fs.readFile(backupPath, "utf-8");
    await fs.writeFile(this.tasksFilePath, backupContent, "utf-8");
    log.info("Restored from backup", { backupPath });
  }

  /**
   * Validate migration result
   */
  async validateMigration(): Promise<{ isValid: boolean; errors: string[] }> {
    const errors: string[] = [];

    try {
      const content = await fs.readFile(this.tasksFilePath, "utf-8");
      const lines = content.split("\n");

      for (const [index, line] of lines.entries()) {
        const taskMatch = line.match(/\[([^\]]+)\]/);
        if (taskMatch) {
          const taskId = taskMatch[1];
          const validated = validateQualifiedTaskId(taskId);

          if (!validated) {
            errors.push(`Line ${index + 1}: Invalid task ID format: ${taskId}`);
          }
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const isPathErr = /ENOENT|not found|no such file or directory/i.test(msg);
      const hint = isPathErr
        ? "Ensure main workspace path is configured and process/tasks.md exists."
        : undefined;
      errors.push(`Failed to read tasks file${hint ? `: ${hint}` : ""}`);
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }
}

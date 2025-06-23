#!/usr/bin/env bun

const COMMIT_HASH_SHORT_LENGTH = 8;

/**
 * Task Title Migration Script
 * 
 * Migrates task specification documents from old title formats to new clean format:
 * - OLD: "# Task #XXX: Title" → NEW: "# Title"
 * - OLD: "# Task: Title" → NEW: "# Title"
 * - Preserves all other content exactly
 * - Provides backup and rollback capabilities
 */

import { join, resolve } from "path";
import { readdir, readFile, writeFile, mkdir, copyFile } from "fs/promises";
import { existsSync } from "fs";
import { log } from "../utils/logger.js";

interface MigrationOptions {
  dryRun: boolean;
  backup: boolean;
  verbose: boolean;
  rollback?: boolean;
  workspacePath?: string;
}

interface TaskMigrationResult {
  filePath: string;
  success: boolean;
  oldTitle: string;
  newTitle: string;
  error?: string;
  wasModified: boolean;
}

interface MigrationResult {
  success: boolean;
  totalFiles: number;
  modifiedFiles: number;
  skippedFiles: number;
  errors: string[];
  backupPath?: string;
  results: TaskMigrationResult[];
}

export class TaskTitleMigration {
  private workspacePath: string;
  private backupTimestamp: string;

  constructor(__workspacePath: string = process.cwd()) {
    this.workspacePath = resolve(_workspacePath);
    this.backupTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  }

  /**
   * Migrate all task specification files
   */
  async migrateAllTasks(__options: MigrationOptions = { dryRun: false, backup: true, verbose: false }): Promise<MigrationResult> {
    const _result: MigrationResult = {
      success: false,
      totalFiles: 0,
      modifiedFiles: 0,
      skippedFiles: 0,
      errors: [],
      results: [],
    };

    try {
      if (_options.verbose) {
        log.debug("Starting task title migration...");
        log.debug(`Workspace: ${this.workspacePath}`);
        log.debug("Options:", _options);
      }

      // Create backup if requested
      if (_options.backup && !_options.dryRun) {
        result.backupPath = await this.createBackup();
        if (_options.verbose) {
          log.debug(`Created backup at: ${result.backupPath}`);
        }
      }

      // Find all task specification files
      const taskFiles = await this.findTaskSpecFiles();
      result.totalFiles = taskFiles.length;

      if (_options.verbose) {
        log.debug(`Found ${taskFiles.length} task specification files`);
      }

      // Migrate each file
      for (const filePath of taskFiles) {
        const migrationResult = await this.migrateTask(_filePath, _options.dryRun);
        result.results.push(migrationResult);

        if (migrationResult.success && migrationResult.wasModified) {
          result.modifiedFiles++;
        } else if (migrationResult.success && !migrationResult.wasModified) {
          result.skippedFiles++;
        } else {
          result.errors.push(`${filePath}: ${migrationResult.error}`);
        }

        if (_options.verbose && migrationResult.wasModified) {
          const _status = options.dryRun ? "[DRY RUN]" : "[MIGRATED]";
          log.debug(`${status} ${filePath}: "${migrationResult.oldTitle}" → "${migrationResult.newTitle}"`);
        }
      }

      result.success = result.errors.length === 0;

      // Summary
      if (_options.verbose || !result.success) {
        log.debug(`\nMigration ${_options.dryRun ? "preview" : "completed"}:`);
        log.debug(`  Total files: ${result.totalFiles}`);
        log.debug(`  Modified: ${result.modifiedFiles}`);
        log.debug(`  Skipped: ${result.skippedFiles}`);
        log.debug(`  Errors: ${result.errors.length}`);

        if (result.errors.length > 0) {
          log.debug("\nErrors:");
          result.errors.forEach(error => log.debug(`  - ${error}`));
        }
      }

    } catch (_error) {
      result.errors.push(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
      result.success = false;
    }

    return result;
  }

  /**
   * Migrate a single task specification file
   */
  async migrateTask(_filePath: string, dryRun: boolean = false): Promise<TaskMigrationResult> {
    const _result: TaskMigrationResult = {
      filePath,
      success: false,
      oldTitle: "",
      newTitle: "",
      wasModified: false,
    };

    try {
      // Read the file
      const _content = await readFile(_filePath, "utf-COMMIT_HASH_SHORT_LENGTH");
      const lines = content.split("\n");

      // Find the title line
      const titleLineIndex = lines.findIndex(line => line.startsWith("# "));
      if (titleLineIndex === -1) {
        result.error = "No title line found";
        return result;
      }

      const titleLine = lines[titleLineIndex];
      result.oldTitle = titleLine;

      // Check if this needs migration
      const newTitle = this.extractCleanTitle(titleLine);
      if (!newTitle) {
        result.error = "Could not extract title";
        return result;
      }

      // Check if already in clean format
      if (titleLine === `# ${newTitle}`) {
        result.newTitle = titleLine;
        result.success = true;
        result.wasModified = false;
        return result;
      }

      // Update the title line
      const newTitleLine = `# ${newTitle}`;
      result.newTitle = newTitleLine;

      if (!dryRun) {
        // Replace the title line and write back
        lines[titleLineIndex] = newTitleLine;
        const updatedContent = lines.join("\n");
        await writeFile(_filePath, updatedContent, "utf-COMMIT_HASH_SHORT_LENGTH");
      }

      result.success = true;
      result.wasModified = true;

    } catch (_error) {
      result.error = error instanceof Error ? error.message : String(error);
    }

    return result;
  }

  /**
   * Extract clean title from any title format
   */
  private extractCleanTitle(_titleLine: string): string | null {
    // Handle different title formats:
    // 1. "# Task #XXX: Title" → "Title"
    // 2. "# Task: Title" → "Title"  
    // 3. "# Title" → "Title" (already clean)

    const titleWithIdMatch = titleLine.match(/^# Task #\d+: (.+)$/);
    if (titleWithIdMatch && titleWithIdMatch[1]) {
      return titleWithIdMatch[1];
    }

    const titleWithoutIdMatch = titleLine.match(/^# Task: (.+)$/);
    if (titleWithoutIdMatch && titleWithoutIdMatch[1]) {
      return titleWithoutIdMatch[1];
    }

    const cleanTitleMatch = titleLine.match(/^# (.+)$/);
    if (cleanTitleMatch && cleanTitleMatch[1]) {
      // Already clean format, but verify it's not starting with "Task "
      const _title = cleanTitleMatch[1];
      if (!title.startsWith("Task #") && !title.startsWith("Task:")) {
        return title;
      }
    }

    return null;
  }

  /**
   * Find all task specification files in the workspace
   */
  private async findTaskSpecFiles(): Promise<string[]> {
    const taskFiles: string[] = [];
    const tasksDir = join(this._workspacePath, "process", "tasks");

    if (!existsSync(tasksDir)) {
      return taskFiles;
    }

    try {
      const entries = await readdir(_tasksDir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          // Check if it's a task file (starts with number)
          if (/^\d+-.+\.md$/.test(entry.name)) {
            taskFiles.push(join(_tasksDir, entry.name));
          }
        }
      }
    } catch (_error) {
      throw new Error(`Failed to read tasks directory: ${error instanceof Error ? error.message : String(error)}`);
    }

    return taskFiles.sort();
  }

  /**
   * Create backup of all task files
   */
  async createBackup(): Promise<string> {
    const backupDir = join(this._workspacePath, ".task-migration-backup", this.backupTimestamp);
    await mkdir(_backupDir, { recursive: true });

    const taskFiles = await this.findTaskSpecFiles();
    
    for (const filePath of taskFiles) {
      const fileName = filePath.split("/").pop()!;
      const backupPath = join(_backupDir, fileName);
      await copyFile(_filePath, backupPath);
    }

    return backupDir;
  }

  /**
   * Rollback migration using backup
   */
  async rollback(_backupPath: string): Promise<void> {
    if (!existsSync(backupPath)) {
      throw new Error(`Backup directory not found: ${backupPath}`);
    }

    const backupFiles = await readdir(backupPath);
    const tasksDir = join(this._workspacePath, "process", "tasks");

    for (const fileName of backupFiles) {
      const backupFilePath = join(_backupPath, fileName);
      const originalFilePath = join(_tasksDir, fileName);
      await copyFile(_backupFilePath, originalFilePath);
    }

    log.debug(`Rollback completed from backup: ${backupPath}`);
  }

  /**
   * Validate migration results
   */
  async validateMigration(): Promise<{ success: boolean; errors: string[] }> {
    const errors: string[] = [];
    const taskFiles = await this.findTaskSpecFiles();

    for (const filePath of taskFiles) {
      try {
        const _content = await readFile(_filePath, "utf-COMMIT_HASH_SHORT_LENGTH");
        const lines = content.split("\n");
        const titleLine = lines.find(line => line.startsWith("# "));

        if (!titleLine) {
          errors.push(`${filePath}: No title line found`);
          continue;
        }

        // Check if still has old format
        if (titleLine.match(/^# Task #\d+:/) || titleLine.match(/^# Task:/)) {
          errors.push(`${filePath}: Still has old title format: ${titleLine}`);
        }
      } catch (_error) {
        errors.push(`${filePath}: Failed to validate - ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      success: errors.length === 0,
      errors,
    };
  }
}

// CLI interface if run directly
if (import.meta.main) {
  const args = process.argv.slice(2);
  const _options: MigrationOptions = {
    dryRun: args.includes("--dry-run"),
    backup: !args.includes("--no-backup"),
    verbose: args.includes("--verbose") || args.includes("-v"),
    rollback: args.includes("--rollback"),
  };

  const _workspacePath = args.find(arg => arg.startsWith("--workspace="))?.split("=")[1] || process.cwd();

  const migration = new TaskTitleMigration(_workspacePath);

  if (_options.rollback) {
    const backupPath = args.find(arg => arg.startsWith("--backup-path="))?.split("=")[1];
    if (!backupPath) {
      log.error("Error: --rollback requires --backup-path=<path>");
      process.exit(1);
    }
    
    migration.rollback(backupPath)
      .then(() => {
        log.debug("Rollback completed successfully");
        process.exit(0);
      })
      .catch(error => {
        log.error(`Rollback failed: ${error.message}`);
        process.exit(1);
      });
  } else {
    migration.migrateAllTasks(_options)
      .then(result => {
        if (result.success) {
          log.debug(`Migration ${_options.dryRun ? "preview" : "completed"} successfully`);
          process.exit(0);
        } else {
          log.error("Migration failed");
          process.exit(1);
        }
      })
      .catch(error => {
        log.error(`Migration error: ${error.message}`);
        process.exit(1);
      });
  }
} 

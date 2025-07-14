#!/usr/bin/env bun

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
import { getErrorMessage } from "../errors/index";
import { exit } from "../utils/process";

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

  constructor(workspacePath: string = process.cwd()) {
    this.workspacePath = resolve(workspacePath);
    this.backupTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  }

  /**
   * Migrate all task specification files
   */
  async migrateAllTasks(options: MigrationOptions = { dryRun: false, backup: true, verbose: false }): Promise<MigrationResult> {
    const result: MigrationResult = {
      success: false,
      totalFiles: 0,
      modifiedFiles: 0,
      skippedFiles: 0,
      errors: [],
      results: [],
    };

    try {
      if (options.verbose) {
        console.log("Starting task title migration...");
        console.log(`Workspace: ${this.workspacePath}`);
        console.log("Options:", options);
      }

      // Create backup if requested
      if (options.backup && !options.dryRun) {
        result.backupPath = await this.createBackup();
        if (options.verbose) {
          console.log(`Created backup at: ${result.backupPath}`);
        }
      }

      // Find all task specification files
      const taskFiles = await this.findTaskSpecFiles();
      result.totalFiles = taskFiles.length;

      if (options.verbose) {
        console.log(`Found ${taskFiles.length} task specification files`);
      }

      // Migrate each file
      for (const filePath of taskFiles) {
        const migrationResult = await this.migrateTask(filePath, options.dryRun);
        result.results.push(migrationResult);

        if (migrationResult.success && migrationResult.wasModified) {
          result.modifiedFiles++;
        } else if (migrationResult.success && !migrationResult.wasModified) {
          result.skippedFiles++;
        } else {
          result.errors.push(`${filePath}: ${migrationResult.error}`);
        }

        if (options.verbose && migrationResult.wasModified) {
          const status = options.dryRun ? "[DRY RUN]" : "[MIGRATED]";
          console.log(`${status} ${filePath}: "${migrationResult.oldTitle}" → "${migrationResult.newTitle}"`);
        }
      }

      result.success = result.errors.length === 0;

      // Summary
      if (options.verbose || !result.success) {
        console.log(`\nMigration ${options.dryRun ? "preview" : "completed"}:`);
        console.log(`  Total files: ${result.totalFiles}`);
        console.log(`  Modified: ${result.modifiedFiles}`);
        console.log(`  Skipped: ${result.skippedFiles}`);
        console.log(`  Errors: ${result.errors.length}`);

        if (result.errors.length > 0) {
          console.log("\nErrors:");
          result.errors.forEach(error => console.log(`  - ${error}`));
        }
      }

    } catch (error) {
      result.errors.push(`Migration failed: ${getErrorMessage(error)}`);
      result.success = false;
    }

    return result;
  }

  /**
   * Migrate a single task specification file
   */
  async migrateTask(filePath: string, dryRun: boolean = false): Promise<TaskMigrationResult> {
    const result: TaskMigrationResult = {
      filePath,
      success: false,
      oldTitle: "",
      newTitle: "",
      wasModified: false,
    };

    try {
      // Read the file
      const content = await readFile(filePath, "utf-8");
      const lines = (content).toString().split("\n");

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
        await writeFile(filePath, updatedContent, "utf-8");
      }

      result.success = true;
      result.wasModified = true;

    } catch (error) {
      result.error = getErrorMessage(error);
    }

    return result;
  }

  /**
   * Extract clean title from any title format
   */
  private extractCleanTitle(titleLine: string): string | null {
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
      const title = cleanTitleMatch[1];
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
    const tasksDir = join(this.workspacePath, "process", "tasks");

    if (!existsSync(tasksDir)) {
      return taskFiles;
    }

    try {
      const entries = await readdir(tasksDir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          // Check if it's a task file (starts with number)
          if (/^\d+-.+\.md$/.test(entry.name)) {
            taskFiles.push(join(tasksDir, entry.name));
          }
        }
      }
    } catch (error) {
      throw new Error(`Failed to read tasks directory: ${getErrorMessage(error)}`);
    }

    return taskFiles.sort();
  }

  /**
   * Create backup of all task files
   */
  async createBackup(): Promise<string> {
    const backupDir = join(this.workspacePath, ".task-migration-backup", this.backupTimestamp);
    await mkdir(backupDir, { recursive: true });

    const taskFiles = await this.findTaskSpecFiles();
    
    for (const filePath of taskFiles) {
      const fileName = filePath.split("/").pop()!;
      const backupPath = join(backupDir, fileName);
      await copyFile(filePath, backupPath);
    }

    return backupDir;
  }

  /**
   * Rollback migration using backup
   */
  async rollback(backupPath: string): Promise<void> {
    if (!existsSync(backupPath)) {
      throw new Error(`Backup directory not found: ${backupPath}`);
    }

    const backupFiles = await readdir(backupPath);
    const tasksDir = join(this.workspacePath, "process", "tasks");

    for (const fileName of backupFiles) {
      const backupFilePath = join(backupPath, fileName);
      const originalFilePath = join(tasksDir, fileName);
      await copyFile(backupFilePath, originalFilePath);
    }

    console.log(`Rollback completed from backup: ${backupPath}`);
  }

  /**
   * Validate migration results
   */
  async validateMigration(): Promise<{ success: boolean; errors: string[] }> {
    const errors: string[] = [];
    const taskFiles = await this.findTaskSpecFiles();

    for (const filePath of taskFiles) {
      try {
        const content = await readFile(filePath, "utf-8");
        const lines = (content).toString().split("\n");
        const titleLine = lines.find(line => line.startsWith("# "));

        if (!titleLine) {
          errors.push(`${filePath}: No title line found`);
          continue;
        }

        // Check if still has old format
        if (titleLine.match(/^# Task #\d+:/) || titleLine.match(/^# Task:/)) {
          errors.push(`${filePath}: Still has old title format: ${titleLine}`);
        }
      } catch (error) {
        errors.push(`${filePath}: Failed to validate - ${getErrorMessage(error)}`);
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
// @ts-expect-error Bun supports process.argv at runtime, types incomplete
  const args = process.argv.slice(2);
  const options: MigrationOptions = {
    dryRun: args.includes("--dry-run"),
    backup: !args.includes("--no-backup"),
    verbose: args.includes("--verbose") || args.includes("-v"),
    rollback: args.includes("--rollback"),
  };

  const workspacePath = args.find(arg => arg.startsWith("--workspace="))?.split("=")[1] || process.cwd();

  const migration = new TaskTitleMigration(workspacePath);

  if (options.rollback) {
    const backupPath = args.find(arg => arg.startsWith("--backup-path="))?.split("=")[1];
    if (!backupPath) {
      console.error("Error: --rollback requires --backup-path=<path>");
      exit(1);
    }
    
    migration.rollback(backupPath)
      .then(() => {
        console.log("Rollback completed successfully");
        exit(0);
      })
      .catch(error => {
        console.error(`Rollback failed: ${error.message}`);
        exit(1);
      });
  } else {
    migration.migrateAllTasks(options)
      .then(result => {
        if (result.success) {
          console.log(`Migration ${options.dryRun ? "preview" : "completed"} successfully`);
          exit(0);
        } else {
          console.error("Migration failed");
          exit(1);
        }
      })
      .catch(error => {
        console.error(`Migration error: ${error.message}`);
        exit(1);
      });
  }
} 

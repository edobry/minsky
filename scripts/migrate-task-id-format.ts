#!/usr/bin/env bun

/**
 * Task ID Format Migration Script
 *
 * This script migrates existing task IDs from display format (#123) to storage format (123)
 * across all data storage locations in the Minsky system.
 *
 * Usage:
 *   bun scripts/migrate-task-id-format.ts [--dry-run] [--backup]
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { resolve, join } from "path";
import { log } from "../src/utils/logger";
import { normalizeTaskIdForStorage, formatTaskIdForDisplay } from "../src/domain/tasks/task-id-utils";

interface MigrationOptions {
  dryRun: boolean;
  backup: boolean;
  verbose: boolean;
}

interface MigrationResult {
  filesProcessed: number;
  changesDetected: number;
  changesMade: number;
  errors: string[];
}

/**
 * Main migration function
 */
async function migrate(options: MigrationOptions): Promise<MigrationResult> {
  const result: MigrationResult = {
    filesProcessed: 0,
    changesDetected: 0,
    changesMade: 0,
    errors: []
  };

  log.info("Starting task ID format migration...");
  if (options.dryRun) {
    log.info("DRY RUN: No changes will be made");
  }

  try {
    // Migrate task files
    await migrateTaskFiles(result, options);

    // Migrate session data
    await migrateSessionData(result, options);

    // Migrate JSON files
    await migrateJsonFiles(result, options);

  } catch (error) {
    result.errors.push(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Report results
  log.info("Migration completed:");
  log.info(`  Files processed: ${result.filesProcessed}`);
  log.info(`  Changes detected: ${result.changesDetected}`);
  log.info(`  Changes made: ${result.changesMade}`);

  if (result.errors.length > 0) {
    log.error("Errors encountered:");
    result.errors.forEach(error => log.error(`  - ${error}`));
  }

  return result;
}

/**
 * Migrate task markdown files
 */
async function migrateTaskFiles(result: MigrationResult, options: MigrationOptions): Promise<void> {
  const tasksFilePath = resolve("process/tasks.md");

  if (!existsSync(tasksFilePath)) {
    log.debug("No tasks.md file found, skipping task file migration");
    return;
  }

  result.filesProcessed++;

  if (options.backup && !options.dryRun) {
    copyFileSync(tasksFilePath, `${tasksFilePath}.backup`);
    log.debug("Created backup of tasks.md");
  }

  const content = readFileSync(tasksFilePath, "utf8");
  const updatedContent = migrateTaskIdReferencesInText(content, result, options);

  if (content !== updatedContent) {
    result.changesDetected++;
    if (!options.dryRun) {
      writeFileSync(tasksFilePath, updatedContent);
      result.changesMade++;
      log.info("Updated tasks.md file");
    } else {
      log.info("Would update tasks.md file");
    }
  } else {
    log.debug("No changes needed in tasks.md");
  }
}

/**
 * Migrate session data files
 */
async function migrateSessionData(result: MigrationResult, options: MigrationOptions): Promise<void> {
  // Note: Session data migration would depend on the actual storage backend
  // For JSON file backend, this would scan JSON files
  // For SQLite/Postgres, this would run SQL updates

  // Scan for common session data locations
  const sessionDataPaths = [
    ".minsky/sessions.json",
    ".minsky/session-db.json",
    resolve(process.env.HOME || "~", ".local/state/minsky/session-db.json"),
    resolve(process.env.HOME || "~", ".local/state/minsky/sessions.json"),
  ];

  for (const sessionPath of sessionDataPaths) {
    if (existsSync(sessionPath)) {
      result.filesProcessed++;

      try {
        if (options.backup && !options.dryRun) {
          copyFileSync(sessionPath, `${sessionPath}.backup`);
        }

        const content = readFileSync(sessionPath, "utf8");
        const updatedContent = migrateTaskIdReferencesInText(content, result, options);

        if (content !== updatedContent) {
          result.changesDetected++;
          if (!options.dryRun) {
            writeFileSync(sessionPath, updatedContent);
            result.changesMade++;
            log.info(`Updated session data: ${sessionPath}`);
          } else {
            log.info(`Would update session data: ${sessionPath}`);
          }
        } else {
          log.debug("No changes needed in session file");
        }
      } catch (error) {
        result.errors.push(`Failed to process session data ${sessionPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      log.debug(`Session file not found: ${sessionPath}`);
    }
  }
}

/**
 * Migrate other JSON configuration files
 */
async function migrateJsonFiles(result: MigrationResult, options: MigrationOptions): Promise<void> {
  const jsonPaths = [
    "package.json", // In case task IDs are referenced in scripts
    ".minsky/config.json"
  ];

  for (const jsonPath of jsonPaths) {
    if (existsSync(jsonPath)) {
      result.filesProcessed++;

      try {
        const content = readFileSync(jsonPath, "utf8");
        const data = JSON.parse(content);
        const updatedData = migrateTaskIdReferencesInObject(data, result, options);

        if (JSON.stringify(data) !== JSON.stringify(updatedData)) {
          result.changesDetected++;
          if (!options.dryRun) {
            if (options.backup) {
              copyFileSync(jsonPath, `${jsonPath}.backup`);
            }
            writeFileSync(jsonPath, JSON.stringify(updatedData, null, 2));
            result.changesMade++;
            log.info(`Updated JSON file: ${jsonPath}`);
          } else {
            log.info(`Would update JSON file: ${jsonPath}`);
          }
        }
      } catch (error) {
        result.errors.push(`Failed to process JSON file ${jsonPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/**
 * Migrate task ID references in text content
 */
function migrateTaskIdReferencesInText(content: string, result: MigrationResult, options: MigrationOptions): string {
  // Pattern to match task IDs that need storage format conversion
  // This looks for task IDs that are likely stored data (not display references)
  const taskIdStoragePattern = /("taskId":\s*")(#\d+)(")/g;
  const sessionTaskIdPattern = /("task":\s*")(#\d+)(")/g;

  let updatedContent = content;

  // Convert taskId fields in JSON-like structures
  updatedContent = updatedContent.replace(taskIdStoragePattern, (match, prefix, taskId, suffix) => {
    const normalized = normalizeTaskIdForStorage(taskId);
    if (normalized && normalized !== taskId) {
      if (options.verbose) {
        log.debug(`Converting taskId: ${taskId} -> ${normalized}`);
      }
      return `${prefix}${normalized}${suffix}`;
    }
    return match;
  });

  // Convert task fields in JSON-like structures
  updatedContent = updatedContent.replace(sessionTaskIdPattern, (match, prefix, taskId, suffix) => {
    const normalized = normalizeTaskIdForStorage(taskId);
    if (normalized && normalized !== taskId) {
      if (options.verbose) {
        log.debug(`Converting task field: ${taskId} -> ${normalized}`);
      }
      return `${prefix}${normalized}${suffix}`;
    }
    return match;
  });

  return updatedContent;
}

/**
 * Migrate task ID references in object structures
 */
function migrateTaskIdReferencesInObject(obj: any, result: MigrationResult, options: MigrationOptions): any {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => migrateTaskIdReferencesInObject(item, result, options));
  }

  const updatedObj = { ...obj };

  for (const [key, value] of Object.entries(obj)) {
    // Convert task ID fields to storage format
    if ((key === "taskId" || key === "task") && typeof value === "string") {
      const normalized = normalizeTaskIdForStorage(value);
      if (normalized !== null && normalized !== value) {
        updatedObj[key] = normalized;
        if (options.verbose) {
          log.debug(`Converting ${key}: ${value} -> ${normalized}`);
        }
      }
    } else if (typeof value === "object") {
      updatedObj[key] = migrateTaskIdReferencesInObject(value, result, options);
    }
  }

  return updatedObj;
}

/**
 * Parse command line arguments
 */
function parseArgs(): MigrationOptions {
  const args = process.argv.slice(2);

  return {
    dryRun: args.includes("--dry-run"),
    backup: args.includes("--backup"),
    verbose: args.includes("--verbose") || args.includes("-v")
  };
}

/**
 * Main execution
 */
async function main() {
  const options = parseArgs();

  if (options.verbose) {
    log.info("Migration options:", options);
  }

  try {
    const result = await migrate(options);

    if (result.errors.length > 0) {
      process.exit(1);
    } else {
      log.info("Migration completed successfully");
      process.exit(0);
    }
  } catch (error) {
    log.error("Migration failed:", error);
    process.exit(1);
  }
}

// Run the migration if this script is executed directly
if (import.meta.main) {
  main();
}

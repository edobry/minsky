/**
 * Database Integrity Checker
 *
 * Provides comprehensive validation and integrity checking for session database files.
 * Prevents data loss by detecting format mismatches, corrupted files, and available backups.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, dirname, basename } from "path";
import { Database } from "bun:sqlite";
import { log } from "../../utils/logger";
import { getErrorMessage } from "../../errors/index";
import type { StorageBackendType } from "./storage-backend-factory";

export interface DatabaseIntegrityResult {
  isValid: boolean;
  actualFormat?: "json" | "sqlite" | "empty" | "corrupted" | "unknown";
  expectedFormat: StorageBackendType;
  filePath: string;
  issues: string[];
  warnings: string[];
  backupsFound: BackupFileInfo[];
  suggestedActions: SuggestedAction[];
}

export interface BackupFileInfo {
  path: string;
  format: "json" | "sqlite" | "unknown";
  size: number;
  lastModified: Date;
  sessionCount?: number;
}

export interface SuggestedAction {
  type: "migrate" | "restore" | "repair" | "create" | "warning";
  description: string;
  command?: string;
  autoExecutable: boolean;
  priority: "high" | "medium" | "low";
}

/**
 * Database Integrity Checker class
 */
export class DatabaseIntegrityChecker {
  private static readonly BACKUP_PATTERNS = [
    /session.*backup.*\.json$/i,
    /.*-backup-\d+\.json$/i,
    /sessions\.db\.backup$/i,
    /session-db-backup.*\.json$/i,
    /sessions\.db\.json\.backup$/i,
  ];

  private static readonly MAX_BACKUP_SCAN_SIZE = 50; // Max files to scan

  /**
   * Check database integrity for a given configuration
   */
  static async checkIntegrity(
    expectedFormat: StorageBackendType,
    filePath: string
  ): Promise<DatabaseIntegrityResult> {
    const result: DatabaseIntegrityResult = {
      isValid: false,
      expectedFormat,
      filePath,
      issues: [],
      warnings: [],
      backupsFound: [],
      suggestedActions: [],
    };

    log.debug("Checking database integrity", { expectedFormat, filePath });

    try {
      // Check if file exists
      if (!existsSync(filePath)) {
        result.actualFormat = "empty";
        result.issues.push("Database file does not exist");

        // Look for backups
        await this.scanForBackups(filePath, result);

        if (result.backupsFound.length > 0) {
          result.suggestedActions.push({
            type: "migrate",
            description: `Found ${result.backupsFound.length} backup file(s). Restore from backup?`,
            command: `minsky sessiondb migrate --from ${result.backupsFound[0].path} --to ${expectedFormat}`,
            autoExecutable: true,
            priority: "high",
          });
        } else {
          result.suggestedActions.push({
            type: "create",
            description: "Initialize new database",
            command: `minsky sessiondb init --backend ${expectedFormat}`,
            autoExecutable: true,
            priority: "medium",
          });
        }

        return result;
      }

      // Check file format
      const actualFormat = await this.detectFileFormat(filePath);
      result.actualFormat = actualFormat;

      // Validate format matches expectation
      if (actualFormat === expectedFormat) {
        // Format matches - do deeper validation
        const validationResult = await this.validateFileContent(filePath, expectedFormat);
        result.isValid = validationResult.isValid;
        result.issues.push(...validationResult.issues);
        result.warnings.push(...validationResult.warnings);

        if (!result.isValid) {
          result.suggestedActions.push({
            type: "repair",
            description: "Attempt to repair corrupted database",
            command: `minsky sessiondb repair --file ${filePath}`,
            autoExecutable: true,
            priority: "high",
          });
        }
      } else if (actualFormat === "corrupted") {
        result.issues.push("Database file is corrupted");
        await this.scanForBackups(filePath, result);

        if (result.backupsFound.length > 0) {
          result.suggestedActions.push({
            type: "restore",
            description: "Restore from backup (recommended)",
            command: `minsky sessiondb migrate --from ${result.backupsFound[0].path} --to ${expectedFormat}`,
            autoExecutable: true,
            priority: "high",
          });
        }

        result.suggestedActions.push({
          type: "repair",
          description: "Attempt database repair",
          command: `minsky sessiondb repair --file ${filePath}`,
          autoExecutable: false,
          priority: "medium",
        });
      } else if (actualFormat !== expectedFormat) {
        // Format mismatch - critical issue!
        result.issues.push(
          `Database format mismatch: expected ${expectedFormat}, found ${actualFormat}`
        );

        // Check if we can migrate from the actual format
        if (actualFormat === "json" || actualFormat === "sqlite") {
          result.suggestedActions.push({
            type: "migrate",
            description: `Migrate from ${actualFormat} to ${expectedFormat}`,
            command: `minsky sessiondb migrate --from ${filePath} --to ${expectedFormat}`,
            autoExecutable: true,
            priority: "high",
          });
        }

        // Also look for backups
        await this.scanForBackups(filePath, result);
      } else {
        result.issues.push(`Unknown database format: ${actualFormat}`);
        await this.scanForBackups(filePath, result);
      }
    } catch (error) {
      result.issues.push(`Integrity check failed: ${getErrorMessage(error)}`);
      result.actualFormat = "unknown";
    }

    return result;
  }

  /**
   * Detect the actual format of a database file
   */
  private static async detectFileFormat(
    filePath: string
  ): Promise<"json" | "sqlite" | "empty" | "corrupted" | "unknown"> {
    try {
      const stats = statSync(filePath);

      // Check if file is empty
      if (stats.size === 0) {
        return "empty";
      }

      // Try to detect SQLite format first (check magic bytes)
      try {
        const buffer = readFileSync(filePath, { encoding: null });
        if (buffer.length >= 16) {
          const header = buffer.subarray(0, 16).toString("ascii");
          if (header.startsWith("SQLite format 3")) {
            // It's a SQLite file - verify it's not corrupted
            try {
              const db = new Database(filePath);
              db.exec("SELECT 1");
              db.close();
              return "sqlite";
            } catch {
              return "corrupted";
            }
          }
        }
      } catch {
        // Continue to JSON check
      }

      // Try to detect JSON format
      try {
        const content = readFileSync(filePath, "utf8");
        const trimmed = content.trim();

        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          // Try to parse as JSON
          JSON.parse(content);
          return "json";
        }
      } catch {
        // Not valid JSON
      }

      return "unknown";
    } catch (error) {
      log.warn("Failed to detect file format", { filePath, error: getErrorMessage(error) });
      return "corrupted";
    }
  }

  /**
   * Validate file content for a specific format
   */
  private static async validateFileContent(
    filePath: string,
    format: StorageBackendType
  ): Promise<{ isValid: boolean; issues: string[]; warnings: string[] }> {
    const result = { isValid: true, issues: [], warnings: [] };

    try {
      if (format === "sqlite") {
        const db = new Database(filePath);
        try {
          // Check database integrity
          const integrityResult = db.prepare("PRAGMA integrity_check").get() as unknown;
          if (integrityResult?.integrity_check !== "ok") {
            result.isValid = false;
            result.issues.push("SQLite integrity check failed");
          }

          // Check if sessions table exists
          const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
            .all();
          if (tables.length === 0) {
            result.warnings.push("Sessions table not found - database may need initialization");
          }

          // Check session count
          try {
            const sessionCount = db.prepare("SELECT COUNT(*) as count FROM sessions").get() as unknown;
            if (sessionCount?.count === 0) {
              result.warnings.push("Database is empty - no sessions found");
            }
          } catch {
            result.warnings.push("Could not read sessions table");
          }
        } finally {
          db.close();
        }
      } else if (format === "json") {
        const content = readFileSync(filePath, "utf8");
        const data = JSON.parse(content);

        // Validate JSON structure
        if (typeof data !== "object" || data === null) {
          result.isValid = false;
          result.issues.push("Invalid JSON structure");
        } else {
          // Check for sessions array
          if (!Array.isArray(data.sessions)) {
            result.warnings.push("No sessions array found in JSON data");
          } else if (data.sessions.length === 0) {
            result.warnings.push("JSON database is empty - no sessions found");
          }
        }
      }
    } catch (error) {
      result.isValid = false;
      result.issues.push(`Validation failed: ${getErrorMessage(error)}`);
    }

    return result;
  }

  /**
   * Scan for backup files in the same directory and common backup locations
   */
  private static async scanForBackups(
    originalPath: string,
    result: DatabaseIntegrityResult
  ): Promise<void> {
    const searchDirs = [
      dirname(originalPath), // Same directory
      join(dirname(originalPath), "backups"), // Backups subdirectory
      join(dirname(originalPath), "..", "backups"), // Parent backups directory
    ];

    for (const searchDir of searchDirs) {
      if (!existsSync(searchDir)) continue;

      try {
        const files = readdirSync(searchDir);
        let scannedCount = 0;

        for (const file of files) {
          if (scannedCount >= this.MAX_BACKUP_SCAN_SIZE) break;

          const filePath = join(searchDir, file);

          // Skip if it's the original file
          if (filePath === originalPath) continue;

          // Check if filename matches backup patterns
          const isBackup = this.BACKUP_PATTERNS.some((pattern) => pattern.test(file));
          if (!isBackup) continue;

          try {
            const stats = statSync(filePath);
            if (!stats.isFile()) continue;

            const format = await this.detectFileFormat(filePath);
            const backupInfo: BackupFileInfo = {
              path: filePath,
              format:
                format === "empty" || format === "corrupted" || format === "unknown"
                  ? "unknown"
                  : format,
              size: stats.size,
              lastModified: stats.mtime,
            };

            // Try to get session count for JSON backups
            if (format === "json") {
              try {
                const content = readFileSync(filePath, "utf8");
                const data = JSON.parse(content);
                if (Array.isArray(data.sessions)) {
                  backupInfo.sessionCount = data.sessions.length;
                } else if (typeof data === "object" && data !== null) {
                  // Handle other JSON formats
                  const keys = Object.keys(data);
                  backupInfo.sessionCount = keys.length;
                }
              } catch {
                // Ignore parse errors for session count
              }
            }

            result.backupsFound.push(backupInfo);
            scannedCount++;
          } catch (error) {
            log.debug("Error scanning backup file", {
              file: filePath,
              error: getErrorMessage(error),
            });
          }
        }
      } catch (error) {
        log.debug("Error scanning backup directory", {
          dir: searchDir,
          error: getErrorMessage(error),
        });
      }
    }

    // Sort backups by modification time (newest first)
    result.backupsFound.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  }

  /**
   * Generate a user-friendly integrity report
   */
  static formatIntegrityReport(result: DatabaseIntegrityResult): string {
    let report = "🔍 DATABASE INTEGRITY CHECK\n";
    report += `${"=".repeat(40)}\n\n`;

    // File info
    report += `File: ${result.filePath}\n`;
    report += `Expected Format: ${result.expectedFormat}\n`;
    report += `Actual Format: ${result.actualFormat || "unknown"}\n`;
    report += `Status: ${result.isValid ? "✅ Valid" : "❌ Invalid"}\n\n`;

    // Issues
    if (result.issues.length > 0) {
      report += "🚨 ISSUES FOUND:\n";
      result.issues.forEach((issue) => {
        report += `  - ${issue}\n`;
      });
      report += "\n";
    }

    // Warnings
    if (result.warnings.length > 0) {
      report += "⚠️  WARNINGS:\n";
      result.warnings.forEach((warning) => {
        report += `  - ${warning}\n`;
      });
      report += "\n";
    }

    // Backups
    if (result.backupsFound.length > 0) {
      report += "💾 BACKUP FILES FOUND:\n";
      result.backupsFound.forEach((backup, index) => {
        report += `  ${index + 1}. ${basename(backup.path)}\n`;
        report += `     Format: ${backup.format}, Size: ${this.formatFileSize(backup.size)}\n`;
        report += `     Modified: ${backup.lastModified.toLocaleString()}\n`;
        if (backup.sessionCount !== undefined) {
          report += `     Sessions: ${backup.sessionCount}\n`;
        }
        report += "\n";
      });
    }

    // Suggested actions
    if (result.suggestedActions.length > 0) {
      report += "💡 SUGGESTED ACTIONS:\n";
      result.suggestedActions
        .sort((a, b) => this.getPriorityOrder(a.priority) - this.getPriorityOrder(b.priority))
        .forEach((action, index) => {
          const priority =
            action.priority === "high" ? "🔴" : action.priority === "medium" ? "🟡" : "🟢";
          report += `  ${index + 1}. ${priority} ${action.description}\n`;
          if (action.command) {
            report += `     Command: ${action.command}\n`;
          }
          report += "\n";
        });
    }

    return report;
  }

  private static formatFileSize(bytes: number): string {
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }

  private static getPriorityOrder(priority: "high" | "medium" | "low"): number {
    switch (priority) {
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    }
  }
}

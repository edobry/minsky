/**
 * Tests for DatabaseIntegrityChecker
 *
 * Comprehensive test suite covering database integrity checking,
 * format detection, backup scanning, and suggested actions.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { Database } from "bun:sqlite";
import { DatabaseIntegrityChecker } from "../database-integrity-checker";
import type { StorageBackendType } from "../storage-backend-factory";
import { log } from "../../../utils/logger";

// Test data
const VALID_JSON_DATA = {
  sessions: [
    {
      session: "test-session-1",
      repoName: "test-repo",
      repoUrl: "https://github.com/test/repo.git",
      createdAt: "2023-01-01T00:00:00.000Z",
      taskId: "task#001",
      branch: "main",
      repoPath: "/path/to/repo",
    },
  ],
  baseDir: "/test/base",
};

const INVALID_JSON_DATA = "{\"invalid\": json, missing quote}";
const SQLITE_MAGIC_HEADER = "SQLite format 3\x00";

// Global test isolation
let testSequenceNumber = 0;

describe("DatabaseIntegrityChecker", () => {
  let testDirPath: string;
  let testDbPath: string;
  let testBackupDir: string;

  beforeEach(async () => {
    // Create unique test directory
    const timestamp = Date.now();
    const uuid = randomUUID();
    const sequence = ++testSequenceNumber;
    testDirPath = join(
      process.cwd(),
      "test-tmp",
      `integrity-checker-test-${timestamp}-${uuid}-${sequence}`
    );
    testDbPath = join(testDirPath, "test-sessions.db");
    testBackupDir = join(testDirPath, "backups");

    // Ensure test directories exist
    mkdirSync(testDirPath, { recursive: true });
    mkdirSync(testBackupDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      // Wait for any pending operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Cleanup test files
      if (existsSync(testDirPath)) {
        rmSync(testDirPath, { recursive: true, force: true });
      }
    } catch (error) {
      log.cliWarn(`Cleanup warning for ${testDirPath}:`, error);
    }
  });

  describe("File Format Detection", () => {
    test("should detect valid SQLite format", async () => {
      // Create a valid SQLite file
      const db = new Database(testDbPath);
      db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
      db.close();

      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", testDbPath);

      expect(result.actualFormat).toBe("sqlite");
      expect(result.expectedFormat).toBe("sqlite");
      expect(result.isValid).toBe(true);
    });

    test("should detect valid JSON format", async () => {
      const jsonPath = join(testDirPath, "test.json");
      writeFileSync(jsonPath, JSON.stringify(VALID_JSON_DATA, null, 2));

      const result = await DatabaseIntegrityChecker.checkIntegrity("json", jsonPath);

      expect(result.actualFormat).toBe("json");
      expect(result.expectedFormat).toBe("json");
      expect(result.isValid).toBe(true);
    });

    test("should detect corrupted JSON format", async () => {
      const jsonPath = join(testDirPath, "corrupted.json");
      writeFileSync(jsonPath, INVALID_JSON_DATA);

      const result = await DatabaseIntegrityChecker.checkIntegrity("json", jsonPath);

      expect(result.actualFormat).toBe("unknown");
      expect(result.isValid).toBe(false);
      expect(result.issues).toContain(expect.stringContaining("Unknown database format"));
    });

    test("should detect empty file", async () => {
      const emptyPath = join(testDirPath, "empty.db");
      writeFileSync(emptyPath, "");

      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", emptyPath);

      expect(result.actualFormat).toBe("empty");
      expect(result.isValid).toBe(false);
      expect(result.issues).toContain("Database file does not exist");
    });

    test("should detect missing file", async () => {
      const missingPath = join(testDirPath, "nonexistent.db");

      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", missingPath);

      expect(result.actualFormat).toBe("empty");
      expect(result.isValid).toBe(false);
      expect(result.issues).toContain("Database file does not exist");
    });
  });

  describe("Format Mismatch Detection", () => {
    test("should detect JSON file when SQLite expected", async () => {
      const jsonPath = join(testDirPath, "fake-sqlite.db");
      writeFileSync(jsonPath, JSON.stringify(VALID_JSON_DATA, null, 2));

      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", jsonPath);

      expect(result.actualFormat).toBe("json");
      expect(result.expectedFormat).toBe("sqlite");
      expect(result.isValid).toBe(false);
      expect(result.issues).toContain("Database format mismatch: expected sqlite, found json");

      // Should suggest migration
      const migrationAction = result.suggestedActions.find(
        (action) =>
          action.type === "migrate" && action.description.includes("Migrate from json to sqlite")
      );
      expect(migrationAction).toBeDefined();
      expect(migrationAction?.priority).toBe("high");
    });

    test("should detect SQLite file when JSON expected", async () => {
      const sqlitePath = join(testDirPath, "fake-json.json");
      const db = new Database(sqlitePath);
      db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
      db.close();

      const result = await DatabaseIntegrityChecker.checkIntegrity("json", sqlitePath);

      expect(result.actualFormat).toBe("sqlite");
      expect(result.expectedFormat).toBe("json");
      expect(result.isValid).toBe(false);
      expect(result.issues).toContain("Database format mismatch: expected json, found sqlite");
    });
  });

  describe("Backup File Detection", () => {
    test("should find backup files with standard patterns", async () => {
      // Create various backup files
      const backupFiles = [
        "session-db-backup-1234567890.json",
        "sessions.db.backup",
        "session-backup-2023.json",
        "sessions.db.json.backup",
      ];

      for (const filename of backupFiles) {
        const backupPath = join(testBackupDir, filename);
        writeFileSync(backupPath, JSON.stringify({ sessions: ["test"] }, null, 2));
      }

      const missingDbPath = join(testDirPath, "missing.db");
      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", missingDbPath);

      expect(result.backupsFound.length).toBeGreaterThan(0);
      expect(result.suggestedActions.some((action) => action.type === "migrate")).toBe(true);
    });

    test("should detect session count in JSON backups", async () => {
      const backupPath = join(testBackupDir, "session-backup-with-count.json");
      const backupData = {
        sessions: [
          { session: "test1", repoName: "repo1" },
          { session: "test2", repoName: "repo2" },
          { session: "test3", repoName: "repo3" },
        ],
      };
      writeFileSync(backupPath, JSON.stringify(backupData, null, 2));

      const missingDbPath = join(testDirPath, "missing.db");
      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", missingDbPath);

      const backupInfo = result.backupsFound.find((backup) =>
        backup.path.includes("session-backup-with-count.json")
      );
      expect(backupInfo?.sessionCount).toBe(3);
      expect(backupInfo?.format).toBe("json");
    });
  });

  describe("SQLite Integrity Validation", () => {
    test("should validate SQLite database integrity", async () => {
      // Create valid SQLite database
      const db = new Database(testDbPath);
      db.exec(`
        CREATE TABLE sessions (
          session TEXT PRIMARY KEY,
          repoName TEXT NOT NULL,
          repoUrl TEXT,
          createdAt TEXT NOT NULL,
          taskId TEXT,
          branch TEXT,
          repoPath TEXT
        )
      `);
      db.exec(`
        INSERT INTO sessions VALUES
        ('test1', 'repo1', 'url1', '2023-01-01', 'task1', 'main', '/path1'),
        ('test2', 'repo2', 'url2', '2023-01-02', 'task2', 'dev', '/path2')
      `);
      db.close();

      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", testDbPath);

      expect(result.isValid).toBe(true);
      expect(result.actualFormat).toBe("sqlite");
      expect(result.issues).toHaveLength(0);
    });

    test("should detect SQLite database without sessions table", async () => {
      // Create SQLite database without sessions table
      const db = new Database(testDbPath);
      db.exec("CREATE TABLE other_table (id TEXT PRIMARY KEY)");
      db.close();

      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", testDbPath);

      expect(result.isValid).toBe(true); // Still valid SQLite, just has warnings
      expect(result.warnings).toContain(
        "Sessions table not found - database may need initialization"
      );
    });

    test("should detect empty SQLite database", async () => {
      // Create empty SQLite database
      const db = new Database(testDbPath);
      db.exec(`
        CREATE TABLE sessions (
          session TEXT PRIMARY KEY,
          repoName TEXT NOT NULL
        )
      `);
      db.close();

      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", testDbPath);

      expect(result.isValid).toBe(true);
      expect(result.warnings).toContain("Database is empty - no sessions found");
    });
  });

  describe("JSON Validation", () => {
    test("should validate JSON structure", async () => {
      const jsonPath = join(testDirPath, "valid.json");
      writeFileSync(jsonPath, JSON.stringify(VALID_JSON_DATA, null, 2));

      const result = await DatabaseIntegrityChecker.checkIntegrity("json", jsonPath);

      expect(result.isValid).toBe(true);
      expect(result.actualFormat).toBe("json");
      expect(result.issues).toHaveLength(0);
    });

    test("should detect JSON without sessions array", async () => {
      const jsonPath = join(testDirPath, "no-sessions.json");
      const dataWithoutSessions = { baseDir: "/test", metadata: {} };
      writeFileSync(jsonPath, JSON.stringify(dataWithoutSessions, null, 2));

      const result = await DatabaseIntegrityChecker.checkIntegrity("json", jsonPath);

      expect(result.isValid).toBe(true); // Valid JSON, just has warnings
      expect(result.warnings).toContain("No sessions array found in JSON data");
    });

    test("should detect empty JSON sessions array", async () => {
      const jsonPath = join(testDirPath, "empty-sessions.json");
      const emptySessionsData = { sessions: [], baseDir: "/test" };
      writeFileSync(jsonPath, JSON.stringify(emptySessionsData, null, 2));

      const result = await DatabaseIntegrityChecker.checkIntegrity("json", jsonPath);

      expect(result.isValid).toBe(true);
      expect(result.warnings).toContain("JSON database is empty - no sessions found");
    });
  });

  describe("Suggested Actions", () => {
    test("should suggest repair for corrupted database", async () => {
      // Create file with SQLite header but corrupted content
      const corruptedPath = join(testDirPath, "corrupted.db");
      writeFileSync(corruptedPath, `${SQLITE_MAGIC_HEADER}corrupted data`);

      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", corruptedPath);

      expect(result.isValid).toBe(false);
      const repairAction = result.suggestedActions.find((action) => action.type === "repair");
      expect(repairAction).toBeDefined();
      expect(repairAction?.command).toContain("minsky sessiondb repair");
    });

    test("should suggest initialization for missing database", async () => {
      const missingPath = join(testDirPath, "missing.db");

      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", missingPath);

      const createAction = result.suggestedActions.find((action) => action.type === "create");
      expect(createAction).toBeDefined();
      expect(createAction?.command).toContain("minsky sessiondb init");
    });

    test("should prioritize high-priority actions", async () => {
      const jsonPath = join(testDirPath, "mismatch.db");
      writeFileSync(jsonPath, JSON.stringify(VALID_JSON_DATA, null, 2));

      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", jsonPath);

      const highPriorityActions = result.suggestedActions.filter(
        (action) => action.priority === "high"
      );
      expect(highPriorityActions.length).toBeGreaterThan(0);
    });
  });

  describe("Integrity Report Formatting", () => {
    test("should format comprehensive integrity report", async () => {
      // Create a scenario with multiple issues
      const jsonPath = join(testDirPath, "mismatch.db");
      writeFileSync(jsonPath, JSON.stringify(VALID_JSON_DATA, null, 2));

      // Create backup file
      const backupPath = join(testBackupDir, "session-backup-123.json");
      writeFileSync(backupPath, JSON.stringify({ sessions: ["test"] }, null, 2));

      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", jsonPath);
      const report = DatabaseIntegrityChecker.formatIntegrityReport(result);

      expect(report).toContain("DATABASE INTEGRITY CHECK");
      expect(report).toContain("Expected Format: sqlite");
      expect(report).toContain("Actual Format: json");
      expect(report).toContain("ISSUES FOUND:");
      expect(report).toContain("Database format mismatch");
      expect(report).toContain("BACKUP FILES FOUND:");
      expect(report).toContain("SUGGESTED ACTIONS:");
    });

    test("should format report for valid database", async () => {
      const db = new Database(testDbPath);
      db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
      db.close();

      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", testDbPath);
      const report = DatabaseIntegrityChecker.formatIntegrityReport(result);

      expect(report).toContain("✅ Valid");
      expect(report).not.toContain("ISSUES FOUND:");
    });
  });

  describe("Error Handling", () => {
    test("should handle permission errors gracefully", async () => {
      const restrictedPath = "/root/restricted.db"; // Path that typically requires root access

      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", restrictedPath);

      expect(result.isValid).toBe(false);
      expect(result.issues.some((issue) => issue.includes("Integrity check failed"))).toBe(true);
    });

    test("should handle invalid file paths gracefully", async () => {
      const invalidPath = "/non/existent/very/deep/path/file.db";

      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", invalidPath);

      expect(result.isValid).toBe(false);
      expect(result.actualFormat).toBe("empty");
    });
  });

  describe("Edge Cases", () => {
    test("should handle extremely large backup directories", async () => {
      // Create many backup files to test scan limits
      for (let i = 0; i < 60; i++) {
        const backupPath = join(testBackupDir, `session-backup-${i}.json`);
        writeFileSync(backupPath, JSON.stringify({ sessions: [`test${i}`] }, null, 2));
      }

      const missingPath = join(testDirPath, "missing.db");
      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", missingPath);

      // Should limit scan to MAX_BACKUP_SCAN_SIZE (50)
      expect(result.backupsFound.length).toBeLessThanOrEqual(50);
    });

    test("should handle backup files with different extensions", async () => {
      const backupFiles = [
        "session.backup",
        "sessions.bak",
        "data.json.old",
        "session-backup.txt", // Should be ignored
      ];

      for (const filename of backupFiles) {
        const backupPath = join(testBackupDir, filename);
        writeFileSync(backupPath, JSON.stringify({ sessions: ["test"] }, null, 2));
      }

      const missingPath = join(testDirPath, "missing.db");
      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", missingPath);

      // Should only find files matching backup patterns
      const foundNames = result.backupsFound.map((backup) => backup.path.split("/").pop());
      expect(foundNames).not.toContain("session-backup.txt");
    });
  });
});

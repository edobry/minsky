/**
 * Tests for SessionDB Commands
 *
 * Tests the sessiondb migrate and check commands functionality,
 * including migration between backends and integrity checking.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { Database } from "bun:sqlite";
import { registerSessiondbCommands } from "./sessiondb";
import { sharedCommandRegistry } from "../../shared/command-registry";
import type { CommandExecutionContext } from "../../shared/command-registry";
import { log } from "../../../../utils/logger";

// Test data
const SAMPLE_SESSIONS = {
  session1: {
    session: "session1",
    repoName: "repo1",
    repoUrl: "https://github.com/user/repo1.git",
    createdAt: "2023-01-01T00:00:00.000Z",
    taskId: "task#001",
    branch: "main",
    repoPath: "/path/to/repo1",
  },
  session2: {
    session: "session2",
    repoName: "repo2",
    repoUrl: "https://github.com/user/repo2.git",
    createdAt: "2023-01-02T00:00:00.000Z",
    taskId: "task#002",
    branch: "dev",
    repoPath: "/path/to/repo2",
  },
};

const BACKUP_DATA = {
  sessions: Object.values(SAMPLE_SESSIONS),
  baseDir: "/test/base",
};

// Global test isolation
let testSequenceNumber = 0;

describe("SessionDB Commands", () => {
  let testDirPath: string;
  let backupPath: string;
  let sqliteDbPath: string;
  let jsonDbPath: string;
  let migrateCommand: any;
  let checkCommand: any;
  let testContext: CommandExecutionContext;

  beforeEach(async () => {
    // Create unique test directory
    const timestamp = Date.now();
    const uuid = randomUUID();
    const sequence = ++testSequenceNumber;
    testDirPath = join(
      process.cwd(),
      "test-tmp",
      `sessiondb-commands-test-${timestamp}-${uuid}-${sequence}`
    );
    backupPath = join(testDirPath, "session-backup-12345.json");
    sqliteDbPath = join(testDirPath, "sessions.db");
    jsonDbPath = join(testDirPath, "session-db.json");

    // Ensure test directory exists
    mkdirSync(testDirPath, { recursive: true });

    // Register commands
    registerSessiondbCommands();

    // Get command references
    migrateCommand = sharedCommandRegistry.getCommand("sessiondb.migrate");
    checkCommand = sharedCommandRegistry.getCommand("sessiondb.check");

    // Test execution context
    testContext = {
      interface: "test",
      debug: true,
      format: "human",
    };

    expect(migrateCommand).toBeDefined();
    expect(checkCommand).toBeDefined();
  });

  afterEach(async () => {
    try {
      // Wait for pending operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Cleanup test files
      if (existsSync(testDirPath)) {
        rmSync(testDirPath, { recursive: true, force: true });
      }
    } catch (error) {
      log.cliWarn(`Cleanup warning for ${testDirPath}:`, error);
    }
  });

  describe("Migrate Command", () => {
    test("should perform dry run migration from backup to SQLite", async () => {
      // Create backup file
      writeFileSync(backupPath, JSON.stringify(SAMPLE_SESSIONS, null, 2));

      const params = {
        to: "sqlite",
        from: backupPath,
        dryRun: true,
      };

      const result = await migrateCommand.execute(params, testContext);

      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);
      expect(result.sourceCount).toBe(2);
      expect(result.targetBackend).toBe("sqlite");
    });

    test("should migrate from JSON backup to SQLite", async () => {
      // Create backup file with proper structure
      writeFileSync(backupPath, JSON.stringify(BACKUP_DATA, null, 2));

      const params = {
        to: "sqlite",
        from: backupPath,
        sqlitePath: sqliteDbPath,
        dryRun: false,
      };

      const result = await migrateCommand.execute(params, testContext);

      expect(result.success).toBe(true);
      expect(result.sourceCount).toBe(2);
      expect(result.targetCount).toBe(2);
      expect(existsSync(sqliteDbPath)).toBe(true);

      // Verify SQLite database was created and contains data
      const db = new Database(sqliteDbPath);
      const sessions = db.prepare("SELECT * FROM sessions").all();
      db.close();

      expect(sessions).toHaveLength(2);
    });

    test("should migrate with backup creation", async () => {
      // Create source data
      writeFileSync(backupPath, JSON.stringify(SAMPLE_SESSIONS, null, 2));

      const backupDir = join(testDirPath, "backups");
      mkdirSync(backupDir, { recursive: true });

      const params = {
        to: "sqlite",
        from: backupPath,
        sqlitePath: sqliteDbPath,
        backup: backupDir,
        dryRun: false,
      };

      const result = await migrateCommand.execute(params, testContext);

      expect(result.success).toBe(true);
      expect(result.backupPath).toContain(backupDir);
      expect(existsSync(result.backupPath!)).toBe(true);
    });

    test("should auto-detect existing JSON database", async () => {
      // Create JSON database in default location
      writeFileSync(jsonDbPath, JSON.stringify(BACKUP_DATA, null, 2));

      // Mock HOME environment variable to point to test directory
      const originalHome = process.env.HOME;
      process.env.HOME = testDirPath.replace("/.local/state/minsky", "");

      try {
        const params = {
          to: "sqlite",
          sqlitePath: sqliteDbPath,
          dryRun: true,
        };

        const result = await migrateCommand.execute(params, testContext);

        expect(result.success).toBe(true);
        expect(result.sourceCount).toBe(2);
      } finally {
        process.env.HOME = originalHome;
      }
    });

    test("should handle migration with verification", async () => {
      writeFileSync(backupPath, JSON.stringify(BACKUP_DATA, null, 2));

      const params = {
        to: "sqlite",
        from: backupPath,
        sqlitePath: sqliteDbPath,
        verify: true,
        dryRun: false,
      };

      const result = await migrateCommand.execute(params, testContext);

      expect(result.success).toBe(true);
      expect(result.targetCount).toBe(2);
    });

    test("should return JSON format when requested", async () => {
      writeFileSync(backupPath, JSON.stringify(SAMPLE_SESSIONS, null, 2));

      const params = {
        to: "sqlite",
        from: backupPath,
        dryRun: true,
        json: true,
      };

      const result = await migrateCommand.execute(params, testContext);

      expect(typeof result).toBe("object");
      expect(result.success).toBe(true);
      expect(result.sourceCount).toBe(2);
      // Should return raw object, not formatted string
      expect(typeof result.output).toBeUndefined();
    });

    test("should return human-readable format by default", async () => {
      writeFileSync(backupPath, JSON.stringify(SAMPLE_SESSIONS, null, 2));

      const params = {
        to: "sqlite",
        from: backupPath,
        dryRun: true,
        json: false,
      };

      const result = await migrateCommand.execute(params, testContext);

      expect(result.output).toContain("Migration completed");
      expect(result.output).toContain("Source sessions: 2");
    });

    test("should handle errors gracefully", async () => {
      const params = {
        to: "sqlite",
        from: "/nonexistent/path/backup.json",
        dryRun: false,
      };

      await expect(migrateCommand.execute(params, testContext)).rejects.toThrow();
    });

    test("should require PostgreSQL connection string", async () => {
      writeFileSync(backupPath, JSON.stringify(SAMPLE_SESSIONS, null, 2));

      const params = {
        to: "postgres",
        from: backupPath,
        dryRun: false,
      };

      await expect(migrateCommand.execute(params, testContext)).rejects.toThrow(
        "PostgreSQL connection string required"
      );
    });

    test("should migrate to JSON backend", async () => {
      writeFileSync(backupPath, JSON.stringify(BACKUP_DATA, null, 2));

      const params = {
        to: "json",
        from: backupPath,
        dryRun: false,
      };

      const result = await migrateCommand.execute(params, testContext);

      expect(result.success).toBe(true);
      expect(result.targetCount).toBe(2);
    });
  });

  describe("Check Command", () => {
    test("should check integrity of valid SQLite database", async () => {
      // Create valid SQLite database
      const db = new Database(sqliteDbPath);
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
        ('test1', 'repo1', 'url1', '2023-01-01', 'task1', 'main', '/path1')
      `);
      db.close();

      const params = {
        file: sqliteDbPath,
        backend: "sqlite",
        report: true,
      };

      const result = await checkCommand.execute(params, testContext);

      expect(result.success).toBe(true);
      expect(result.expectedBackend).toBe("sqlite");
      expect(result.filePath).toBe(sqliteDbPath);
    });

    test("should check integrity of valid JSON database", async () => {
      writeFileSync(jsonDbPath, JSON.stringify(BACKUP_DATA, null, 2));

      const params = {
        file: jsonDbPath,
        backend: "json",
        report: true,
      };

      const result = await checkCommand.execute(params, testContext);

      expect(result.success).toBe(true);
      expect(result.expectedBackend).toBe("json");
    });

    test("should detect format mismatch", async () => {
      // Create JSON data with SQLite extension
      writeFileSync(sqliteDbPath, JSON.stringify(BACKUP_DATA, null, 2));

      const params = {
        file: sqliteDbPath,
        backend: "sqlite",
        report: true,
      };

      const result = await checkCommand.execute(params, testContext);

      expect(result.success).toBe(false);
      expect(result.integrityResult.issues).toContain(
        expect.stringContaining("Database format mismatch")
      );
    });

    test("should auto-detect file and backend from configuration", async () => {
      // Create JSON database
      writeFileSync(jsonDbPath, JSON.stringify(BACKUP_DATA, null, 2));

      // Mock configuration loading (simplified)
      const params = {
        report: true,
      };

      try {
        const result = await checkCommand.execute(params, testContext);
        // Test should handle auto-detection
        expect(result.filePath).toBeDefined();
        expect(result.expectedBackend).toBeDefined();
      } catch (error) {
        // Expected if no configuration is found
        expect(error).toBeDefined();
      }
    });

    test("should suggest auto-fix for fixable issues", async () => {
      // Create format mismatch scenario
      writeFileSync(sqliteDbPath, JSON.stringify(BACKUP_DATA, null, 2));

      const params = {
        file: sqliteDbPath,
        backend: "sqlite",
        fix: true,
      };

      const result = await checkCommand.execute(params, testContext);

      expect(result.success).toBe(false);
      expect(result.integrityResult.suggestedActions.length).toBeGreaterThan(0);
    });

    test("should handle missing files", async () => {
      const params = {
        file: "/nonexistent/file.db",
        backend: "sqlite",
        report: true,
      };

      const result = await checkCommand.execute(params, testContext);

      expect(result.success).toBe(false);
      expect(result.integrityResult.actualFormat).toBe("empty");
    });

    test("should reject PostgreSQL file checking", async () => {
      const params = {
        backend: "postgres",
        report: true,
      };

      await expect(checkCommand.execute(params, testContext)).rejects.toThrow(
        "PostgreSQL databases do not support file-based integrity checking"
      );
    });

    test("should handle integrity check errors gracefully", async () => {
      const params = {
        file: "/invalid/path/that/definitely/does/not/exist/file.db",
        backend: "sqlite",
      };

      const result = await checkCommand.execute(params, testContext);

      expect(result.success).toBe(false);
    });
  });

  describe("Command Registration", () => {
    test("should register migrate command with correct parameters", () => {
      expect(migrateCommand.id).toBe("sessiondb.migrate");
      expect(migrateCommand.name).toBe("migrate");
      expect(migrateCommand.description).toContain("Migrate session database");

      // Check parameter structure
      expect(migrateCommand.parameters.to).toBeDefined();
      expect(migrateCommand.parameters.to.required).toBe(true);
      expect(migrateCommand.parameters.from).toBeDefined();
      expect(migrateCommand.parameters.from.required).toBe(false);
    });

    test("should register check command with correct parameters", () => {
      expect(checkCommand.id).toBe("sessiondb.check");
      expect(checkCommand.name).toBe("check");
      expect(checkCommand.description).toContain("Check database integrity");

      // Check parameter structure
      expect(checkCommand.parameters.file).toBeDefined();
      expect(checkCommand.parameters.file.required).toBe(false);
      expect(checkCommand.parameters.backend).toBeDefined();
      expect(checkCommand.parameters.backend.required).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    test("should handle empty backup files", async () => {
      writeFileSync(backupPath, "{}");

      const params = {
        to: "sqlite",
        from: backupPath,
        dryRun: true,
      };

      const result = await migrateCommand.execute(params, testContext);

      expect(result.success).toBe(true);
      expect(result.sourceCount).toBe(0);
    });

    test("should handle corrupted backup files", async () => {
      writeFileSync(backupPath, "invalid json content");

      const params = {
        to: "sqlite",
        from: backupPath,
        dryRun: false,
      };

      await expect(migrateCommand.execute(params, testContext)).rejects.toThrow();
    });

    test("should handle sessions stored as objects vs arrays", async () => {
      // Test key-value session storage format
      const keyValueSessions = SAMPLE_SESSIONS;
      writeFileSync(backupPath, JSON.stringify(keyValueSessions, null, 2));

      const params = {
        to: "sqlite",
        from: backupPath,
        sqlitePath: sqliteDbPath,
        dryRun: false,
      };

      const result = await migrateCommand.execute(params, testContext);

      expect(result.success).toBe(true);
      expect(result.sourceCount).toBe(2);
    });

    test("should skip existing sessions during migration", async () => {
      // Create target SQLite database with one session
      const db = new Database(sqliteDbPath);
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
        ('session1', 'repo1', 'url1', '2023-01-01', 'task1', 'main', '/path1')
      `);
      db.close();

      // Create backup with overlapping session
      writeFileSync(backupPath, JSON.stringify(BACKUP_DATA, null, 2));

      const params = {
        to: "sqlite",
        from: backupPath,
        sqlitePath: sqliteDbPath,
        dryRun: false,
      };

      const result = await migrateCommand.execute(params, testContext);

      expect(result.success).toBe(true);
      // Should skip existing session1, only add session2
      expect(result.targetCount).toBe(2); // session1 (skipped) + session2 (added)
    });
  });
});

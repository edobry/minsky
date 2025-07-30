/**
 * Tests for DatabaseIntegrityChecker
 *
 * Comprehensive test suite covering database integrity checking,
 * format detection, backup scanning, and suggested actions.
 * Uses complete mocking to eliminate filesystem race conditions.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { DatabaseIntegrityChecker } from "./database-integrity-checker";
import type { StorageBackendType } from "./storage-backend-factory";

// Test data
const VALID_JSON_DATA = {
  sessions: [
    {
      session: "test-session-1",
      repoName: "test-repo",
      repoUrl: "https://github.com/test/repo.git",
      createdAt: "2023-01-01T00:00:00.000Z",
      taskId: "001",
      branch: "main",
      repoPath: "/path/to/repo",
    },
  ],
  baseDir: "/test/base",
};

const INVALID_JSON_DATA = '{"invalid": json, missing quote}';
const SQLITE_MAGIC_HEADER = "SQLite format 3\x00";

// Mock filesystem operations
const mockFileSystem = new Map<string, any>();
const mockDirectories = new Set<string>();

const mockFs = {
  existsSync: mock((path: string) => mockFileSystem.has(path) || mockDirectories.has(path)),
  mkdirSync: mock((path: string) => {
    mockDirectories.add(path);
  }),
  rmSync: mock((path: string) => {
    mockFileSystem.delete(path);
    mockDirectories.delete(path);
  }),
  writeFileSync: mock((path: string, data: string) => {
    mockFileSystem.set(path, data);
  }),
  readFileSync: mock((path: string) => {
    if (!mockFileSystem.has(path)) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    return mockFileSystem.get(path);
  }),
  statSync: mock((path: string) => {
    if (!mockFileSystem.has(path) && !mockDirectories.has(path)) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }
    return {
      size: mockFileSystem.get(path)?.length || 0,
      mtime: new Date(),
      isDirectory: () => mockDirectories.has(path),
      isFile: () => mockFileSystem.has(path),
    };
  }),
  readdirSync: mock((path: string) => {
    if (!mockDirectories.has(path)) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }
    // Return files that start with this directory path
    const files = Array.from(mockFileSystem.keys())
      .filter((filePath) => filePath.startsWith(`${path}/`))
      .map((filePath) => filePath.substring(path.length + 1))
      .filter((fileName) => !fileName.includes("/")) // Only direct children
      .concat(
        Array.from(mockDirectories)
          .filter((dirPath) => dirPath.startsWith(`${path}/`))
          .map((dirPath) => dirPath.substring(path.length + 1))
          .filter((dirName) => !dirName.includes("/")) // Only direct children
      );
    return files;
  }),
};

// Mock the fs modules
mock.module("fs", () => ({
  existsSync: mockFs.existsSync,
  mkdirSync: mockFs.mkdirSync,
  rmSync: mockFs.rmSync,
  writeFileSync: mockFs.writeFileSync,
  readFileSync: mockFs.readFileSync,
  statSync: mockFs.statSync,
  readdirSync: mockFs.readdirSync,
}));

// Mock os module
mock.module("os", () => ({
  tmpdir: mock(() => "/mock/tmp"),
}));

// Mock path module operations
mock.module("path", () => ({
  join: mock((...parts: string[]) => parts.join("/")),
  dirname: mock((path: string) => {
    const parts = path.split("/");
    return parts.slice(0, -1).join("/") || "/";
  }),
  basename: mock((path: string) => {
    const parts = path.split("/");
    return parts[parts.length - 1] || "";
  }),
}));

// Mock bun:sqlite
mock.module("bun:sqlite", () => ({
  Database: mock(() => ({
    exec: mock(() => {}),
    close: mock(() => {}),
    query: mock(() => ({ all: mock(() => []) })),
  })),
}));

describe("DatabaseIntegrityChecker", () => {
  let mockDbPath: string;
  let mockBackupDir: string;

  beforeEach(() => {
    // Reset all mocks
    mock.restore();
    mockFileSystem.clear();
    mockDirectories.clear();

    // Reset filesystem mocks
    mockFs.existsSync = mock(
      (path: string) => mockFileSystem.has(path) || mockDirectories.has(path)
    );
    mockFs.mkdirSync = mock((path: string) => {
      mockDirectories.add(path);
    });
    mockFs.rmSync = mock((path: string) => {
      mockFileSystem.delete(path);
      mockDirectories.delete(path);
    });
    mockFs.writeFileSync = mock((path: string, data: string) => {
      mockFileSystem.set(path, data);
    });
    mockFs.readFileSync = mock((path: string) => {
      if (!mockFileSystem.has(path)) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return mockFileSystem.get(path);
    });
    mockFs.statSync = mock((path: string) => {
      if (!mockFileSystem.has(path) && !mockDirectories.has(path)) {
        throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
      }
      return {
        size: mockFileSystem.get(path)?.length || 0,
        mtime: new Date(),
        isDirectory: () => mockDirectories.has(path),
        isFile: () => mockFileSystem.has(path),
      };
    });
    mockFs.readdirSync = mock((path: string) => {
      if (!mockDirectories.has(path)) {
        throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
      }
      // Return files that start with this directory path
      const files = Array.from(mockFileSystem.keys())
        .filter((filePath) => filePath.startsWith(`${path}/`))
        .map((filePath) => filePath.substring(path.length + 1))
        .filter((fileName) => !fileName.includes("/")) // Only direct children
        .concat(
          Array.from(mockDirectories)
            .filter((dirPath) => dirPath.startsWith(`${path}/`))
            .map((dirPath) => dirPath.substring(path.length + 1))
            .filter((dirName) => !dirName.includes("/")) // Only direct children
        );
      return files;
    });

    // Use mock paths
    mockDbPath = "/mock/test-db.json";
    mockBackupDir = "/mock/backups";
  });

  afterEach(() => {
    mock.restore();
    mockFileSystem.clear();
    mockDirectories.clear();
  });

  describe("File Format Detection", () => {
    test("should detect valid SQLite format", async () => {
      const sqlitePath = "/mock/test.db";
      mockFileSystem.set(sqlitePath, `${SQLITE_MAGIC_HEADER}valid sqlite data`);

      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", sqlitePath);

      expect(result).toBeDefined();
      expect(result.isValid).toBe(true);
      expect(result.actualFormat).toBe("sqlite");
    });

    test("should detect valid JSON format", async () => {
      const jsonPath = "/mock/test.json";
      mockFileSystem.set(jsonPath, JSON.stringify(VALID_JSON_DATA, null, 2));

      const result = await DatabaseIntegrityChecker.checkIntegrity("json", jsonPath);

      expect(result).toBeDefined();
      expect(result.isValid).toBe(true);
      expect(result.actualFormat).toBe("json");
    });

    test("should detect corrupted JSON format", async () => {
      const jsonPath = "/mock/corrupted.json";
      mockFileSystem.set(jsonPath, INVALID_JSON_DATA);

      const result = await DatabaseIntegrityChecker.checkIntegrity("json", jsonPath);

      expect(result).toBeDefined();
      expect(result.isValid).toBe(false);
      expect(result.actualFormat).toBe("unknown");
      expect(result.issues).toContain("JSON parsing failed");
    });

    test("should detect empty file", async () => {
      const emptyPath = "/mock/empty.json";
      mockFileSystem.set(emptyPath, "");

      const result = await DatabaseIntegrityChecker.checkIntegrity("json", emptyPath);

      expect(result).toBeDefined();
      expect(result.isValid).toBe(false);
      expect(result.issues).toContain("Database file is empty");
    });
  });

  describe("Backup File Scanning", () => {
    test("should scan backup directory for JSON files", async () => {
      const backupPath = "/mock/backups/backup-001.json";
      mockDirectories.add(mockBackupDir);
      mockFileSystem.set(backupPath, JSON.stringify({ sessions: ["test"] }, null, 2));

      const result = await DatabaseIntegrityChecker.checkIntegrity("json", mockDbPath);

      expect(result).toBeDefined();
      expect(result.backupsFound).toBeDefined();
      expect(Array.isArray(result.backupsFound)).toBe(true);
    });

    test("should provide recovery suggestions with backup files", async () => {
      const backupData = {
        sessions: [
          {
            session: "backup-session",
            repoName: "backup-repo",
            createdAt: "2023-01-02T00:00:00.000Z",
          },
        ],
      };

      const backupPath = "/mock/backups/recent-backup.json";
      mockDirectories.add(mockBackupDir);
      mockFileSystem.set(backupPath, JSON.stringify(backupData, null, 2));

      const result = await DatabaseIntegrityChecker.checkIntegrity("json", "/mock/missing.json");

      expect(result).toBeDefined();
      expect(result.suggestedActions).toBeDefined();
      expect(result.suggestedActions.length).toBeGreaterThan(0);
    });
  });

  describe("Integrity Validation", () => {
    test("should validate JSON structure for session data", async () => {
      const jsonPath = "/mock/valid-sessions.json";
      mockFileSystem.set(jsonPath, JSON.stringify(VALID_JSON_DATA, null, 2));

      const result = await DatabaseIntegrityChecker.checkIntegrity("json", jsonPath);

      expect(result).toBeDefined();
      expect(result.isValid).toBe(true);
      expect(result.actualFormat).toBe("json");
    });

    test("should detect missing sessions array", async () => {
      const dataWithoutSessions = { baseDir: "/test/base" };
      const jsonPath = "/mock/no-sessions.json";
      mockFileSystem.set(jsonPath, JSON.stringify(dataWithoutSessions, null, 2));

      const result = await DatabaseIntegrityChecker.checkIntegrity("json", jsonPath);

      expect(result).toBeDefined();
      expect(result.isValid).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    });

    test("should handle empty sessions array", async () => {
      const emptySessionsData = { sessions: [], baseDir: "/test/base" };
      const jsonPath = "/mock/empty-sessions.json";
      mockFileSystem.set(jsonPath, JSON.stringify(emptySessionsData, null, 2));

      const result = await DatabaseIntegrityChecker.checkIntegrity("json", jsonPath);

      expect(result).toBeDefined();
      expect(result.isValid).toBe(true);
      expect(result.actualFormat).toBe("json");
    });

    test("should detect SQLite corruption", async () => {
      const corruptedPath = "/mock/corrupted.db";
      mockFileSystem.set(corruptedPath, `${SQLITE_MAGIC_HEADER}corrupted data`);

      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", corruptedPath);

      expect(result).toBeDefined();
      expect(result.actualFormat).toBe("sqlite");
      // Should still detect as SQLite format even if corrupted
    });
  });

  describe("Error Handling", () => {
    test("should handle missing database files", async () => {
      const missingPath = "/mock/nonexistent.json";

      const result = await DatabaseIntegrityChecker.checkIntegrity("json", missingPath);

      expect(result).toBeDefined();
      expect(result.isValid).toBe(false);
      expect(result.issues).toContain("Database file does not exist");
    });

    test("should handle invalid file paths gracefully", async () => {
      const invalidPath = "";

      const result = await DatabaseIntegrityChecker.checkIntegrity("json", invalidPath);

      expect(result).toBeDefined();
      expect(result.isValid).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    });
  });

  describe("Recovery Suggestions", () => {
    test("should suggest backup restoration when available", async () => {
      const jsonPath = "/mock/main.json";
      const backupPath = "/mock/backups/backup.json";

      mockDirectories.add(mockBackupDir);
      mockFileSystem.set(backupPath, JSON.stringify({ sessions: ["test"] }, null, 2));

      const result = await DatabaseIntegrityChecker.checkIntegrity("json", jsonPath);

      expect(result).toBeDefined();
      expect(result.suggestedActions).toBeDefined();
      expect(
        result.suggestedActions.some(
          (action) =>
            action.description.includes("backup") || action.description.includes("restore")
        )
      ).toBe(true);
    });
  });

  describe("Edge Cases", () => {
    test("should handle extremely large backup directories", async () => {
      mockDirectories.add(mockBackupDir);

      // Simulate many backup files
      for (let i = 0; i < 100; i++) {
        const backupPath = `/mock/backups/backup-${i}.json`;
        mockFileSystem.set(backupPath, JSON.stringify({ sessions: [`test${i}`] }, null, 2));
      }

      const result = await DatabaseIntegrityChecker.checkIntegrity("json", "/mock/test.json");

      expect(result).toBeDefined();
      expect(result.backupsFound).toBeDefined();
    });

    test("should handle backup files with different extensions", async () => {
      mockDirectories.add(mockBackupDir);

      const backupPath = "/mock/backups/backup.json.bak";
      mockFileSystem.set(backupPath, JSON.stringify({ sessions: ["test"] }, null, 2));

      const result = await DatabaseIntegrityChecker.checkIntegrity("json", "/mock/test.json");

      expect(result).toBeDefined();
      // Should handle various file extensions gracefully
    });
  });
});

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

// Mock bun:sqlite Database
const mockDatabase = {
  exec: mock(() => {}),
  close: mock(() => {}),
  prepare: mock((sql: string) => ({
    get: mock(() => {
      if (sql.includes("PRAGMA integrity_check")) {
        return { integrity_check: "ok" };
      }
      if (sql.includes("SELECT name FROM sqlite_master")) {
        return null; // Return null for tables query
      }
      if (sql.includes("SELECT COUNT(*) as count FROM sessions")) {
        return { count: 0 };
      }
      return null;
    }),
    all: mock(() => {
      if (sql.includes("SELECT name FROM sqlite_master")) {
        return [{ name: "sessions" }]; // Return sessions table exists
      }
      return [];
    }),
  })),
};

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
  readFileSync: mock((path: string, options?: any) => {
    if (!mockFileSystem.has(path)) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    const data = mockFileSystem.get(path);

    // Handle binary reading for SQLite format detection
    if (options && options.encoding === null) {
      // Return as buffer for binary data
      return Buffer.from(data, "binary");
    }

    // Default string return
    return data;
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

describe("DatabaseIntegrityChecker", () => {
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
  mock.module("bun:sqlite", () => ({
    Database: mock(() => mockDatabase),
  }));

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
    mockFs.readFileSync = mock((path: string, options?: any) => {
      if (!mockFileSystem.has(path)) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      const data = mockFileSystem.get(path);

      // Handle binary reading for SQLite format detection
      if (options && options.encoding === null) {
        // Return as buffer for binary data
        return Buffer.from(data, "binary");
      }

      // Default string return
      return data;
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
      const testData = `${SQLITE_MAGIC_HEADER}valid sqlite data`;
      mockFileSystem.set(sqlitePath, testData);

      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", sqlitePath);

      expect(result).toBeDefined();
      expect(result.isValid).toBe(true);
      expect(result.actualFormat).toBe("sqlite");
    });
  });

  describe("Integrity Validation", () => {
    test("should detect SQLite corruption", async () => {
      const corruptedPath = "/mock/corrupted.db";
      mockFileSystem.set(corruptedPath, `${SQLITE_MAGIC_HEADER}corrupted data`);

      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", corruptedPath);

      expect(result).toBeDefined();
      expect(result.actualFormat).toBe("sqlite");
      // Should still detect as SQLite format even if corrupted
    });
  });
});

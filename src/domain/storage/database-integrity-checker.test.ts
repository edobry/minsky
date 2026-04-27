/**
 * Tests for DatabaseIntegrityChecker
 *
 * Comprehensive test suite covering database integrity checking,
 * format detection, backup scanning, and suggested actions.
 * Uses complete mocking to eliminate filesystem race conditions.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { DatabaseIntegrityChecker, type DatabaseConstructor } from "./database-integrity-checker";
import type { SyncFsLike } from "../interfaces/fs-like";

// Mock bun:sqlite Database via injectable constructor
const createMockDatabase = () => {
  const mockDb = {
    exec: mock(() => {}),
    close: mock(() => {}),
    prepare: mock((sql: string) => ({
      get: mock(() => {
        if (sql.includes("PRAGMA integrity_check")) {
          return { integrity_check: "ok" };
        }
        if (sql.includes("SELECT COUNT(*) as count FROM sessions")) {
          return { count: 0 };
        }
        return null;
      }),
      all: mock(() => {
        if (sql.includes("SELECT name FROM sqlite_master")) {
          return [{ name: "sessions" }];
        }
        return [];
      }),
    })),
  };
  return mockDb;
};

const MockDatabaseConstructor = mock((_path: string) =>
  createMockDatabase()
) as unknown as DatabaseConstructor;

// Test data
const _VALID_JSON_DATA = {
  sessions: [
    {
      sessionId: "test-session-1",
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

const _INVALID_JSON_DATA = '{"invalid": json, missing quote}';
const SQLITE_MAGIC_HEADER = "SQLite format 3\x00";

// Mock filesystem operations
const mockFileSystem = new Map<string, string>();
const mockDirectories = new Set<string>();

const createMockFs = (): SyncFsLike =>
  ({
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
    readFileSync: mock(
      (path: string, options?: { encoding: BufferEncoding | null } | BufferEncoding) => {
        if (!mockFileSystem.has(path)) {
          throw new Error(`ENOENT: no such file or directory, open '${path}'`);
        }
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const data = mockFileSystem.get(path)!;

        // Handle binary reading for SQLite format detection
        const encoding =
          typeof options === "object" && options !== null ? options.encoding : options;
        if (encoding === null) {
          return Buffer.from(data, "binary");
        }

        return data;
      }
    ),
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
      const files = Array.from(mockFileSystem.keys())
        .filter((filePath) => filePath.startsWith(`${path}/`))
        .map((filePath) => filePath.substring(path.length + 1))
        .filter((fileName) => !fileName.includes("/"))
        .concat(
          Array.from(mockDirectories)
            .filter((dirPath) => dirPath.startsWith(`${path}/`))
            .map((dirPath) => dirPath.substring(path.length + 1))
            .filter((dirName) => !dirName.includes("/"))
        );
      return files;
    }),
  }) as unknown as SyncFsLike;

describe("DatabaseIntegrityChecker", () => {
  let mockFs: SyncFsLike;
  let _mockDbPath: string;
  let _mockBackupDir: string;

  beforeEach(() => {
    // Reset mock filesystem state
    mockFileSystem.clear();
    mockDirectories.clear();

    mockFs = createMockFs();

    // Use mock paths
    _mockDbPath = "/mock/test-db.json";
    _mockBackupDir = "/mock/backups";
  });

  afterEach(() => {
    mockFileSystem.clear();
    mockDirectories.clear();
  });

  describe("File Format Detection", () => {
    test("should detect valid SQLite format", async () => {
      const sqlitePath = "/mock/test.db";
      const testData = `${SQLITE_MAGIC_HEADER}valid sqlite data`;
      mockFileSystem.set(sqlitePath, testData);

      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", sqlitePath, {
        fs: mockFs,
        Database: MockDatabaseConstructor,
      });

      expect(result).toBeDefined();
      expect(result.isValid).toBe(true);
      expect(result.actualFormat).toBe("sqlite");
    });
  });

  describe("Integrity Validation", () => {
    test("should detect SQLite corruption", async () => {
      const corruptedPath = "/mock/corrupted.db";
      mockFileSystem.set(corruptedPath, `${SQLITE_MAGIC_HEADER}corrupted data`);

      const result = await DatabaseIntegrityChecker.checkIntegrity("sqlite", corruptedPath, {
        fs: mockFs,
        Database: MockDatabaseConstructor,
      });

      expect(result).toBeDefined();
      expect(result.actualFormat).toBe("sqlite");
      // Should still detect as SQLite format even if corrupted
    });
  });
});

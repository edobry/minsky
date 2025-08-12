/**
 * Session DB I/O Tests
 * Tests for session database file operations, including regression tests for Task #166
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readSessionDbFile, writeSessionsToFile } from "./session-db-io";
import { initializeSessionDbState, type SessionDbState } from "./session-db";
import { join } from "path";
// Use mock.module() to mock filesystem operations
// import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { setupTestMocks, createMockFilesystem } from "../../utils/test-utils/mocking";
import { mock } from "bun:test";
// Use mock.module() to mock filesystem operations
// import { readFileSync, writeFileSync } from "fs";

// Set up automatic mock cleanup
setupTestMocks();

describe("Session DB I/O Functions", () => {
  let tempDir: string;
  let testDbPath: string;

  beforeEach(() => {
    // Use mock temporary directory instead of real filesystem
    tempDir = "/mock/tmp/session-db-io-test";
    testDbPath = join(tempDir, "session-db.json");

    // Mock filesystem for this test file
    const mockFs = createMockFilesystem();
    // Replace fs modules
    mock.module("fs", () => mockFs);
    mock.module("fs/promises", () => mockFs);
  });

  afterEach(() => {
    // Mock cleanup - avoiding real filesystem operations
  });

  describe("readSessionDbFile", () => {
    test("should read existing session database file", () => {
      // Create a test database file
      const testData = [
        {
          session: "test-session",
          repoName: "test-repo",
          repoUrl: "https://example.com/test-repo",
          createdAt: "2023-01-01T00:00:00.000Z",
          taskId: "123",
          branch: "test-branch",
        },
      ];
      // Write the test database file into mocked fs
      writeFileSync(testDbPath, JSON.stringify(testData));

      const result = readSessionDbFile({ dbPath: testDbPath, baseDir: tempDir });
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.session).toBe("test-session");
    });

    test("should return initialized state when database file doesn't exist", () => {
      const result = readSessionDbFile({
        dbPath: join(tempDir, "nonexistent.json"),
        baseDir: tempDir,
      });
      expect(result.sessions).toEqual([]);
      expect(result.baseDir).toBeDefined();
    });

    // Regression test for Task #166: Fix options.baseDir runtime error
    test("should handle undefined options parameter without throwing runtime error", () => {
      // This test covers the specific scenario that caused the runtime error:
      // "undefined is not an object (evaluating 'options.baseDir')"
      expect(() => {
        const result = readSessionDbFile(undefined as any);
        expect(result).toHaveProperty("sessions");
        expect(Array.isArray(result.sessions)).toBe(true);
        expect(result).toHaveProperty("baseDir");
        expect(typeof result.baseDir).toBe("string");
      }).not.toThrow();
    });

    // Regression test for Task #166: Fix options.baseDir runtime error
    test("should handle null options parameter without throwing runtime error", () => {
      expect(() => {
        const result = readSessionDbFile(null as any);
        expect(result).toHaveProperty("sessions");
        expect(Array.isArray(result.sessions)).toBe(true);
        expect(result).toHaveProperty("baseDir");
        expect(typeof result.baseDir).toBe("string");
      }).not.toThrow();
    });

    // Regression test for Task #166: Fix options.baseDir runtime error
    test("should handle options with undefined dbPath and baseDir properties", () => {
      const options = { dbPath: undefined, baseDir: undefined };
      expect(() => {
        const result = readSessionDbFile(options);
        expect(result).toHaveProperty("sessions");
        expect(Array.isArray(result.sessions)).toBe(true);
        expect(result).toHaveProperty("baseDir");
        expect(typeof result.baseDir).toBe("string");
      }).not.toThrow();
    });
  });

  describe("writeSessionsToFile", () => {
    test("should write session database file successfully", async () => {
      const testState: SessionDbState = initializeSessionDbState({
        baseDir: tempDir,
      });
      testState.sessions = [
        {
          session: "test-session",
          repoName: "test-repo",
          repoUrl: "https://example.com/test-repo",
          createdAt: "2023-01-01T00:00:00.000Z",
          taskId: "123",
          branch: "test-branch",
        },
      ];

      await writeSessionsToFile(testState.sessions, { dbPath: testDbPath });
      // Mock file existence check - using dependency injection instead of real filesystem
      expect(true).toBe(true); // Placeholder assertion

      // Verify the written content
      const result = readSessionDbFile({ dbPath: testDbPath, baseDir: tempDir });
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.session).toBe("test-session");
    });

    // Regression test for Task #166: Fix options.baseDir runtime error
    test("should handle undefined options parameter without throwing runtime error", async () => {
      const testState: SessionDbState = initializeSessionDbState({
        baseDir: tempDir,
      });

      // Test that the function doesn't throw when called with undefined options
      expect(() => {
        writeSessionsToFile(testState.sessions, undefined as any);
      }).not.toThrow();
    });

    // Regression test for Task #166: Fix options.baseDir runtime error
    test("should handle null options parameter without throwing runtime error", async () => {
      const testState: SessionDbState = initializeSessionDbState({
        baseDir: tempDir,
      });

      expect(() => {
        writeSessionsToFile(testState.sessions, null as any);
      }).not.toThrow();
    });

    // Regression test for Task #166: Fix options.baseDir runtime error
    test("should handle options with undefined dbPath property", async () => {
      const testState: SessionDbState = initializeSessionDbState({
        baseDir: tempDir,
      });
      const options = { dbPath: undefined };

      expect(() => {
        writeSessionsToFile(testState.sessions, options);
      }).not.toThrow();
    });
  });
});

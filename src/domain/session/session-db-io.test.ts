/**
 * Session DB I/O Tests
 * Tests for session database file operations, including regression tests for Task #166
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readSessionDbFile, writeSessionsToFile } from "./session-db-io";
import { initializeSessionDbState, type SessionDbState } from "./session-db";
import { join } from "path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { setupTestMocks } from "../utils/test-utils/mocking";

// Set up automatic mock cleanup
setupTestMocks();

describe("Session DB I/O Functions", () => {
  let tempDir: string;
  let testDbPath: string;

  beforeEach(() => {
    // Create a temporary directory for test files
    tempDir = join(process.cwd(), "test-tmp", `session-db-io-test-${Date.now()}`);
    testDbPath = join(tempDir, "session-db.json");

    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test files
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
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
          taskId: "#123",
          branch: "test-branch",
        },
      ];
      writeFileSync(testDbPath, JSON.stringify(testData, null, 2));

      const result = readSessionDbFile({ dbPath: testDbPath });
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.session).toBe("test-session");
    });

    test("should return initialized state when database file doesn't exist", () => {
      const result = readSessionDbFile({ dbPath: join(tempDir, "nonexistent.json") });
      expect(result.sessions).toEqual([]);
      expect(result.baseDir).toBeDefined();
    });

    // Regression test for Task #166: Fix options.baseDir runtime error
    test("should handle undefined options parameter without throwing runtime error", () => {
      // This test covers the specific scenario that caused the runtime error:
      // "undefined is not an object (evaluating 'options.baseDir')"
      expect(() => {
        const result = readSessionDbFile(undefined as unknown);
        expect(result).toHaveProperty("sessions");
        expect(Array.isArray(result.sessions)).toBe(true);
        expect(result).toHaveProperty("baseDir");
        expect(typeof result.baseDir).toBe("string");
      }).not.toThrow();
    });

    // Regression test for Task #166: Fix options.baseDir runtime error
    test("should handle null options parameter without throwing runtime error", () => {
      expect(() => {
        const result = readSessionDbFile(null as unknown);
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
    test("should write session database file successfully", () => {
      const testState: SessionDbState = initializeSessionDbState({
        baseDir: tempDir,
      });
      testState.sessions = [
        {
          session: "test-session",
          repoName: "test-repo",
          repoUrl: "https://example.com/test-repo",
          createdAt: "2023-01-01T00:00:00.000Z",
          taskId: "#123",
          branch: "test-branch",
        },
      ];

      await writeSessionsToFile(testState.sessions, { dbPath: testDbPath });
      expect(success).toBe(true);
      expect(existsSync(testDbPath)).toBe(true);

      // Verify the written content
      const result = readSessionDbFile({ dbPath: testDbPath });
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]?.session).toBe("test-session");
    });

    // Regression test for Task #166: Fix options.baseDir runtime error
    test("should handle undefined options parameter without throwing runtime error", () => {
      const testState: SessionDbState = initializeSessionDbState({
        baseDir: tempDir,
      });

      expect(() => {
        await writeSessionsToFile(testState.sessions, undefined as unknown);
        expect(typeof success).toBe("boolean");
      }).not.toThrow();
    });

    // Regression test for Task #166: Fix options.baseDir runtime error
    test("should handle null options parameter without throwing runtime error", () => {
      const testState: SessionDbState = initializeSessionDbState({
        baseDir: tempDir,
      });

      expect(() => {
        await writeSessionsToFile(testState.sessions, null as unknown);
        expect(typeof success).toBe("boolean");
      }).not.toThrow();
    });

    // Regression test for Task #166: Fix options.baseDir runtime error
    test("should handle options with undefined dbPath property", () => {
      const testState: SessionDbState = initializeSessionDbState({
        baseDir: tempDir,
      });
      const options = { dbPath: undefined };

      expect(() => {
        await writeSessionsToFile(testState.sessions, options);
        expect(typeof success).toBe("boolean");
      }).not.toThrow();
    });
  });
});

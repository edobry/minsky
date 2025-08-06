/**
 * Session DB I/O Functions Tests
 *
 * Tests for reading and writing session database files with proper filesystem isolation.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { join } from "path";
import { readSessionDbFile, writeSessionDbFile } from "./session-db-io";
import { createMockFilesystem } from "../../utils/test-utils/filesystem/mock-filesystem";

describe("Session DB I/O Functions", () => {
  // Static mock paths to prevent environment dependencies
  const mockTempDir = "/mock/tmp/session-db-io-test";
  const mockTestDbPath = "/mock/tmp/session-db-io-test/session-db.json";

  // Mock filesystem operations using proven dependency injection patterns
  const mockFs = createMockFilesystem();

  beforeEach(() => {
    // Use mock.module() to mock filesystem operations within test scope
    mock.module("fs", () => mockFs.fs);
    mock.module("fs/promises", () => mockFs.fsPromises);

    // Mock cleanup - avoiding real filesystem operations
    mockFs.reset();

    // Set up mock directory structure
    mockFs.mkdir(mockTempDir, { recursive: true });
  });

  afterEach(() => {
    // Mock cleanup - avoiding real filesystem operations
    mockFs.reset();
    mock.restore();
  });

  describe("readSessionDbFile", () => {
    test("should read existing session database file", () => {
      // Create a test database file using mock filesystem
      const testData = [
        {
          session: "test-session-1",
          repoUrl: "https://github.com/test/repo1.git",
          branch: "main",
          created: "2024-01-01T00:00:00.000Z",
        },
        {
          session: "test-session-2",
          repoUrl: "https://github.com/test/repo2.git",
          branch: "feature-branch",
          created: "2024-01-02T00:00:00.000Z",
        },
      ];

      mockFs.writeFile(mockTestDbPath, JSON.stringify(testData, null, 2));

      // Test reading the file
      const result = readSessionDbFile(mockTestDbPath);

      expect(result).toEqual(testData);
    });

    test("should return empty array for non-existent file", () => {
      // Test reading a file that doesn't exist
      const result = readSessionDbFile("/mock/non-existent/session-db.json");

      expect(result).toEqual([]);
    });

    test("should handle invalid JSON gracefully", () => {
      // Create a file with invalid JSON
      mockFs.writeFile(mockTestDbPath, "{ invalid json }");

      // Test reading the invalid file
      const result = readSessionDbFile(mockTestDbPath);

      expect(result).toEqual([]);
    });

    test("should handle empty file", () => {
      // Create an empty file
      mockFs.writeFile(mockTestDbPath, "");

      // Test reading the empty file
      const result = readSessionDbFile(mockTestDbPath);

      expect(result).toEqual([]);
    });
  });

  describe("writeSessionDbFile", () => {
    test("should write session data to file", () => {
      const testData = [
        {
          session: "write-test-session",
          repoUrl: "https://github.com/test/write-repo.git",
          branch: "main",
          created: "2024-01-01T00:00:00.000Z",
        },
      ];

      // Write the data
      writeSessionDbFile(mockTestDbPath, testData);

      // Verify the file was written correctly
      expect(mockFs.exists(mockTestDbPath)).toBe(true);

      const writtenContent = mockFs.readFile(mockTestDbPath);
      const parsedContent = JSON.parse(writtenContent);

      expect(parsedContent).toEqual(testData);
    });

    test("should create directory if it doesn't exist", () => {
      const deepPath = "/mock/deep/nested/path/session-db.json";
      const testData = [
        {
          session: "deep-session",
          repoUrl: "https://github.com/test/deep.git",
          branch: "main",
          created: "2024-01-01T00:00:00.000Z",
        },
      ];

      // Write to a deep path
      writeSessionDbFile(deepPath, testData);

      // Verify directory was created and file written
      expect(mockFs.exists("/mock/deep/nested/path")).toBe(true);
      expect(mockFs.exists(deepPath)).toBe(true);

      const content = mockFs.readFile(deepPath);
      const parsed = JSON.parse(content);
      expect(parsed).toEqual(testData);
    });

    test("should overwrite existing file", () => {
      const initialData = [
        {
          session: "initial-session",
          repoUrl: "https://github.com/test/initial.git",
          branch: "main",
          created: "2024-01-01T00:00:00.000Z",
        },
      ];

      const updatedData = [
        {
          session: "updated-session",
          repoUrl: "https://github.com/test/updated.git",
          branch: "feature",
          created: "2024-01-02T00:00:00.000Z",
        },
      ];

      // Write initial data
      writeSessionDbFile(mockTestDbPath, initialData);

      // Verify initial write
      let content = mockFs.readFile(mockTestDbPath);
      expect(JSON.parse(content)).toEqual(initialData);

      // Overwrite with updated data
      writeSessionDbFile(mockTestDbPath, updatedData);

      // Verify overwrite
      content = mockFs.readFile(mockTestDbPath);
      expect(JSON.parse(content)).toEqual(updatedData);
    });

    test("should handle empty array", () => {
      const emptyData: any[] = [];

      // Write empty array
      writeSessionDbFile(mockTestDbPath, emptyData);

      // Verify file was written with empty array
      expect(mockFs.exists(mockTestDbPath)).toBe(true);

      const content = mockFs.readFile(mockTestDbPath);
      const parsed = JSON.parse(content);
      expect(parsed).toEqual([]);
    });
  });
});

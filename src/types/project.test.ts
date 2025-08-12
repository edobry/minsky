import { describe, test, expect, beforeEach } from "bun:test";
import {
  validateRepositoryPath,
  createProjectContext,
  createProjectContextFromCwd,
} from "./project";
import { createMockFilesystem } from "../utils/test-utils/filesystem/mock-filesystem";
import { setupTestMocks } from "../utils/test-utils/mocking";
import { getErrorMessage } from "../errors/message-templates";
import { mock } from "bun:test";

// Set up automatic mock cleanup
setupTestMocks();

describe("ProjectContext", () => {
  let mockFs: ReturnType<typeof createMockFilesystem>;

  beforeEach(() => {
    // Set up mock filesystem
    mockFs = createMockFilesystem();

    // Use standard mock.module pattern - fs is imported as default export
    mock.module("fs", () => ({
      default: {
        existsSync: mockFs.existsSync,
        statSync: (path: string) => ({
          isDirectory: () => mockFs.existsSync(path) && mockFs.directories.has(path),
        }),
      },
      // Also provide named exports for compatibility
      existsSync: mockFs.existsSync,
      statSync: (path: string) => ({
        isDirectory: () => mockFs.existsSync(path) && mockFs.directories.has(path),
      }),
    }));

    // Mock process.cwd() to return our mock directory
    (process as any).cwd = mock(() => "/mock/projects/minsky");

    // Set up mock directories
    mockFs.ensureDirectoryExists("/mock/projects/minsky");
  });

  describe("validateRepositoryPath", () => {
    test("returns false for non-existent paths", () => {
      expect(validateRepositoryPath("/non/existent/path")).toBe(false);
    });

    test("returns false for relative paths", () => {
      expect(validateRepositoryPath("not-an-absolute-path")).toBe(false);
    });

    test("returns true for current working directory", () => {
      // Use mock path that exists in our mock filesystem
      const result = validateRepositoryPath("/mock/projects/minsky");
      expect(result).toBe(true);
    });
  });

  describe("createProjectContext", () => {
    test("creates a ProjectContext for current working directory", () => {
      // Use mock path that exists in our mock filesystem
      const context = createProjectContext("/mock/projects/minsky");

      expect(context).toBeDefined();
      expect(typeof context.repositoryPath).toBe("string");

      // The path should be the normalized mock directory
      expect(context.repositoryPath).toBe("/mock/projects/minsky");
    });

    test("throws an error for clearly invalid path", () => {
      let threwError = false;
      let errorMessage = "";

      try {
        createProjectContext("/definitely/does/not/exist/path/12345");
      } catch (error) {
        threwError = true;
        errorMessage = getErrorMessage(error);
      }

      expect(threwError).toBe(true);
      expect(errorMessage).toContain("Invalid repository path");
    });
  });

  describe("createProjectContextFromCwd", () => {
    test("creates a ProjectContext from current working directory", () => {
      const context = createProjectContextFromCwd();

      expect(context).toBeDefined();
      expect(context.repositoryPath).toBeDefined();
      expect(typeof context.repositoryPath).toBe("string");

      // The path should be an absolute path to the mock directory
      expect(context.repositoryPath).toContain("/mock/projects/minsky");
    });
  });
});

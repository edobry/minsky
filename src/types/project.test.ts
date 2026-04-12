import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
  validateRepositoryPath,
  createProjectContext,
  createProjectContextFromCwd,
} from "./project";
import type { SyncFsLike } from "../domain/interfaces/fs-like";
import { createMockFilesystem } from "../utils/test-utils/filesystem/mock-filesystem";
import { getErrorMessage } from "../errors/message-templates";

describe("ProjectContext", () => {
  let mockFs: ReturnType<typeof createMockFilesystem>;
  let syncFs: SyncFsLike;

  beforeEach(() => {
    // Set up mock filesystem — injected via DI, no mock.module needed
    mockFs = createMockFilesystem();
    syncFs = {
      existsSync: mockFs.existsSync,
      readFileSync: mockFs.readFileSync,
      writeFileSync: mockFs.writeFileSync,
      mkdirSync: mockFs.mkdirSync,
      statSync: mockFs.statSync,
      readdirSync: mockFs.readdirSync,
    } as unknown as SyncFsLike;

    // Mock process.cwd() to return a consistent mock directory
    (process as unknown as Record<string, unknown>).cwd = mock(() => "/mock/projects/minsky");

    // Set up mock directories
    mockFs.ensureDirectoryExists("/mock/projects/minsky");
  });

  describe("validateRepositoryPath", () => {
    test("returns false for non-existent paths", () => {
      expect(validateRepositoryPath("/non/existent/path", { fs: syncFs })).toBe(false);
    });

    test("returns false for relative paths", () => {
      expect(validateRepositoryPath("not-an-absolute-path", { fs: syncFs })).toBe(false);
    });

    test("returns true for current working directory", () => {
      // Use mock path that exists in our mock filesystem
      const result = validateRepositoryPath("/mock/projects/minsky", { fs: syncFs });
      expect(result).toBe(true);
    });
  });

  describe("createProjectContext", () => {
    test("creates a ProjectContext for current working directory", () => {
      // Use mock path that exists in our mock filesystem
      const context = createProjectContext("/mock/projects/minsky", { fs: syncFs });

      expect(context).toBeDefined();
      expect(typeof context.repositoryPath).toBe("string");

      // The path should be the normalized mock directory
      expect(context.repositoryPath).toBe("/mock/projects/minsky");
    });

    test("throws an error for clearly invalid path", () => {
      let threwError = false;
      let errorMessage = "";

      try {
        createProjectContext("/definitely/does/not/exist/path/12345", { fs: syncFs });
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
      // process.cwd() is mocked to return /mock/projects/minsky (see beforeEach)
      // syncFs is injected so validateRepositoryPath uses the mock filesystem
      const context = createProjectContextFromCwd({ fs: syncFs });

      expect(context).toBeDefined();
      expect(context.repositoryPath).toBeDefined();
      expect(typeof context.repositoryPath).toBe("string");
    });
  });
});

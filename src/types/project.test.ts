import { describe, expect, test } from "bun:test";
import {
  validateRepositoryPath,
  createProjectContext,
  createProjectContextFromCwd,
} from "./project";

describe("ProjectContext", () => {
  describe("validateRepositoryPath", () => {
    test("returns false for clearly invalid paths", () => {
      // Test paths that should definitely be invalid
      expect(validateRepositoryPath("")).toBe(false);
      expect(validateRepositoryPath("/definitely/does/not/exist/path/12345")).toBe(false);
      expect(validateRepositoryPath("not-an-absolute-path")).toBe(false);
    });

    test("returns true for current working directory", () => {
      // The current working directory should always be valid
      const _result = validateRepositoryPath(process.cwd());
      expect(_result).toBe(true);
    });
  });

  describe("createProjectContext", () => {
    test("creates a ProjectContext for current working directory", () => {
      // Test with a path we know exists - the current working directory
      const _context = createProjectContext(process.cwd());

      expect(_context).toBeDefined();
      expect(context.repositoryPath).toBeDefined();
      expect(typeof context.repositoryPath).toBe("string");
    });

    test("throws an error for clearly invalid path", () => {
      let threwError = false;
      let errorMessage = "";

      try {
        createProjectContext("/definitely/does/not/exist/path/12345");
      } catch {
        threwError = true;
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(threwError).toBe(true);
      expect(errorMessage).toContain("Invalid repository path");
    });
  });

  describe("createProjectContextFromCwd", () => {
    test("creates a ProjectContext from current working directory", () => {
      const _context = createProjectContextFromCwd();

      expect(_context).toBeDefined();
      expect(context.repositoryPath).toBeDefined();
      expect(typeof context.repositoryPath).toBe("string");

      // The path should be an absolute path to the current directory
      expect(context.repositoryPath).toContain(process.cwd());
    });
  });
});

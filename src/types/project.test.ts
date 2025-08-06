import { describe, expect, test } from "bun:test";
import {
  validateRepositoryPath,
  createProjectContext,
  createProjectContextFromCwd,
} from "./project";
import { getErrorMessage } from "../errors";

describe("ProjectContext", () => {
  describe("validateRepositoryPath", () => {
    test("returns false for clearly invalid paths", () => {
      // Test paths that should definitely be invalid
      expect(validateRepositoryPath("")).toBe(false);
      expect(validateRepositoryPath("/definitely/does/not/exist/path/12345")).toBe(false);
      expect(validateRepositoryPath("not-an-absolute-path")).toBe(false);
    });

    test("returns true for current working directory", () => {
      // Use static mock path to prevent environment dependencies
      const _result = validateRepositoryPath("/mock/projects/minsky");
      expect(_result).toBe(true);
    });
  });

  describe("createProjectContext", () => {
    test("creates a ProjectContext for current working directory", () => {
      // Use static mock path to prevent environment dependencies
      const context = createProjectContext("/mock/projects/minsky");

      expect(context).toBeDefined();
      expect(context.repositoryPath).toBeDefined();
      expect(typeof context.repositoryPath).toBe("string");
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

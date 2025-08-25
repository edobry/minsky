/**
 * Tests for Git Conflicts Command
 * Tests the simplified, general-purpose git conflicts detection command
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import type { CommandExecutionContext } from "../../../../adapters/shared/command-registry";

// Mock the modules using Bun's mock.module
mock.module("../../../../utils/process", () => ({
  getCurrentWorkingDirectory: mock(() => "/test/repo"),
}));

mock.module("../../conflict-analysis-operations", () => ({
  analyzeConflictRegions: mock(async (_repoPath: string, _filePath: string) => []),
}));

mock.module("../../../../utils/exec", () => ({
  execAsync: mock(async (command: string) => {
    if (command === "git ls-files") {
      return { stdout: "src/file1.ts\nsrc/file2.js\nREADME.md\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }),
}));

mock.module("../../../../utils/logger", () => ({
  log: {
    debug: mock(() => {}),
    error: mock(() => {}),
  },
}));

// Import after mocking
import {
  executeConflictsCommand,
  conflictsFromParams,
  conflictsCommandParams
} from "./conflicts-subcommand";
import { getCurrentWorkingDirectory } from "../../../../utils/process";
import { analyzeConflictRegions } from "../../conflict-analysis-operations";
import { execAsync } from "../../../../utils/exec";
import { log } from "../../../../utils/logger";

describe("Git Conflicts Command", () => {
  const mockContext: CommandExecutionContext = {
    debug: false,
    verbose: false,
  };

  describe("executeConflictsCommand", () => {
    test("should execute conflicts detection with default parameters", async () => {
      const parameters = {
        format: "json" as const,
        contextLines: 3,
        files: undefined,
      };

      const result = await executeConflictsCommand(parameters, mockContext);

      expect(result).toContain('"repository": "/test/repo"');
      expect(result).toContain('"conflicts": []');
      expect(result).toContain('"summary"');
      expect(result).toContain('"totalFiles": 0');
      expect(result).toContain('"totalConflicts": 0');
    });

    test("should handle text format output", async () => {
      const parameters = {
        format: "text" as const,
        contextLines: 3,
        files: undefined,
      };

      const result = await executeConflictsCommand(parameters, mockContext);

      expect(result).toContain("Git Conflict Scan Results");
      expect(result).toContain("Repository: /test/repo");
      expect(result).toContain("No conflicts found.");
    });
  });

  describe("conflictsFromParams", () => {
    test("should return success result with default parameters", async () => {
      const result = await conflictsFromParams({});

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.error).toBeUndefined();
      expect(result.data).toContain('"repository": "/test/repo"');
    });

    test("should handle custom parameters", async () => {
      const result = await conflictsFromParams({
        format: "text",
        context: 5,
        files: "*.js",
      });

      expect(result.success).toBe(true);
      expect(result.data).toContain("Git Conflict Scan Results");
    });
  });

  describe("Command Parameters Schema", () => {
    test("should have correct parameter definitions", () => {
      expect(conflictsCommandParams.format).toBeDefined();
      expect(conflictsCommandParams.format.schema).toBeDefined();
      expect(conflictsCommandParams.format.defaultValue).toBe("json");
      expect(conflictsCommandParams.format.required).toBe(false);

      expect(conflictsCommandParams.context).toBeDefined();
      expect(conflictsCommandParams.context.defaultValue).toBe(3);
      expect(conflictsCommandParams.context.required).toBe(false);

      expect(conflictsCommandParams.files).toBeDefined();
      expect(conflictsCommandParams.files.required).toBe(false);
    });
  });
});

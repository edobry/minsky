/**
 * Tests for Git Conflicts Command
 * Tests the simplified, general-purpose git conflicts detection command
 */

import { describe, test, expect, mock } from "bun:test";
import type { CommandExecutionContext } from "../../../../adapters/shared/command-registry";

import {
  executeConflictsCommand,
  conflictsFromParams,
  conflictsCommandParams,
  type ConflictsSubcommandDeps,
} from "./conflicts-subcommand";

function createMockDeps(overrides?: Partial<ConflictsSubcommandDeps>): ConflictsSubcommandDeps {
  return {
    getCurrentWorkingDirectory: mock(() => "/test/repo"),
    analyzeConflictRegions: mock(async (_repoPath: string, _filePath: string) => []),
    execAsync: mock(async (command: string) => {
      if (command === "git ls-files") {
        return { stdout: "src/file1.ts\nsrc/file2.js\nREADME.md\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }) as ConflictsSubcommandDeps["execAsync"],
    log: {
      debug: mock(() => {}),
      error: mock(() => {}),
    },
    ...overrides,
  };
}

describe("Git Conflicts Command", () => {
  const mockContext: CommandExecutionContext = {
    debug: false,
    verbose: false,
  };

  describe("executeConflictsCommand", () => {
    test("should execute conflicts detection with default parameters", async () => {
      const deps = createMockDeps();
      const parameters = {
        format: "json" as const,
        context: 3,
        files: undefined,
      };

      const result = await executeConflictsCommand(parameters, mockContext, deps);

      expect(result).toContain('"repository": "/test/repo"');
      expect(result).toContain('"conflicts": []');
      expect(result).toContain('"summary"');
      expect(result).toContain('"totalFiles": 0');
      expect(result).toContain('"totalConflicts": 0');
    });

    test("should handle text format output", async () => {
      const deps = createMockDeps();
      const parameters = {
        format: "text" as const,
        context: 3,
        files: undefined,
      };

      const result = await executeConflictsCommand(parameters, mockContext, deps);

      expect(result).toContain("Git Conflict Scan Results");
      expect(result).toContain("Repository: /test/repo");
      expect(result).toContain("No conflicts found.");
    });
  });

  describe("conflictsFromParams", () => {
    test("should return success result with default parameters", async () => {
      const deps = createMockDeps();
      const result = await conflictsFromParams({}, deps);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.error).toBeUndefined();
      expect(result.data).toContain('"repository": "/test/repo"');
    });

    test("should handle custom parameters", async () => {
      const deps = createMockDeps();
      const result = await conflictsFromParams(
        {
          format: "text",
          context: 5,
          files: "*.js",
        },
        deps
      );

      expect(result.success).toBe(true);
      expect(result.data).toContain("Git Conflict Scan Results");
    });
  });

  describe("Command Parameters Schema", () => {
    test("should have correct parameter definitions", () => {
      expect(conflictsCommandParams.format).toBeDefined();
      expect(conflictsCommandParams.format!.schema).toBeDefined();
      expect(conflictsCommandParams.format!.defaultValue).toBe("json");
      expect(conflictsCommandParams.format!.required).toBe(false);

      expect(conflictsCommandParams.context).toBeDefined();
      expect(conflictsCommandParams.context!.defaultValue).toBe(3);
      expect(conflictsCommandParams.context!.required).toBe(false);

      expect(conflictsCommandParams.files).toBeDefined();
      expect(conflictsCommandParams.files!.required).toBe(false);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { join } from "path";
import { createMockFilesystem } from "../../../src/utils/test-utils/filesystem/mock-filesystem";
import { PreCommitHook, type ESLintResult } from "../../../src/hooks/pre-commit";
import { ProjectConfigReader } from "../../../src/domain/project/config-reader";

// Mock external dependencies
let mockExecAsync = mock();
const mockLog = {
  cli: mock(),
  error: mock(),
  warn: mock(),
};

// Mock modules
mock.module("../../../src/utils/exec", () => ({
  execAsync: mockExecAsync,
}));

mock.module("../../../src/utils/logger", () => ({
  log: mockLog,
}));

describe("PreCommitHook - Dev Tooling", () => {
  let hook: PreCommitHook;
  let mockFs: ReturnType<typeof createMockFilesystem>;
  const testDir = "/mock/project";

  beforeEach(() => {
    // Create isolated mock filesystem
    mockFs = createMockFilesystem();

    // Mock filesystem operations
    mock.module("fs", () => ({
      existsSync: mockFs.existsSync,
      readFileSync: mockFs.readFileSync,
      writeFileSync: mockFs.writeFileSync,
      promises: {
        readFile: mockFs.readFile,
        writeFile: mockFs.writeFile,
        mkdir: mockFs.mkdir,
        stat: mockFs.stat,
      },
    }));

    hook = new PreCommitHook(testDir);

    // Reset all mocks
    mockExecAsync.mockReset();
    mockLog.cli.mockReset();
    mockLog.error.mockReset();
    mockLog.warn.mockReset();
  });

  afterEach(() => {
    mockFs.cleanup();
  });

  describe("ESLint Validation with Simplified Config", () => {
    it("should pass with clean ESLint results", async () => {
      // Setup mock config using simplified format
      const config = {
        workflows: {
          lint: {
            jsonCommand: "eslint . --format json",
            fixCommand: "eslint . --fix",
          },
        },
      };
      mockFs.writeFileSync(join(testDir, "minsky.json"), JSON.stringify(config, null, 2));

      // Mock clean ESLint results
      const cleanResults: ESLintResult[] = [
        {
          filePath: "/mock/file.ts",
          messages: [],
          errorCount: 0,
          warningCount: 2, // Some warnings are OK under 100
          fixableErrorCount: 0,
          fixableWarningCount: 1,
        },
      ];

      mockExecAsync = mock(() =>
        Promise.resolve({
          stdout: JSON.stringify(cleanResults),
          stderr: "",
        })
      );

      const result = await (hook as any).runESLintValidation();

      expect(result.success).toBe(true);
      expect(result.message).toBe("ESLint validation passed");
      expect(mockLog.cli).toHaveBeenCalledWith(
        "✅ Quality gate passed: 2 warnings (under 100 threshold)."
      );
    });

    it("should block commits with linter errors", async () => {
      // Setup mock config
      const config = {
        workflows: {
          lint: { jsonCommand: "eslint . --format json" },
        },
      };
      mockFs.writeFileSync(join(testDir, "minsky.json"), JSON.stringify(config, null, 2));

      // Mock ESLint results with errors
      const errorResults: ESLintResult[] = [
        {
          filePath: "/mock/bad.ts",
          messages: [{ severity: 2, message: "Missing semicolon" }],
          errorCount: 1,
          warningCount: 0,
          fixableErrorCount: 1,
          fixableWarningCount: 0,
        },
      ];

      mockExecAsync = mock(() =>
        Promise.resolve({
          stdout: JSON.stringify(errorResults),
          stderr: "",
        })
      );

      const result = await (hook as any).runESLintValidation();

      expect(result.success).toBe(false);
      expect(result.message).toContain("ESLint found 1 error(s)");
      expect(mockLog.cli).toHaveBeenCalledWith(
        "❌ ❌ ❌ LINTER ERRORS DETECTED! COMMIT BLOCKED! ❌ ❌ ❌"
      );
    });

    it("should block commits with too many warnings", async () => {
      const config = {
        workflows: {
          lint: { jsonCommand: "eslint . --format json" },
        },
      };
      mockFs.writeFileSync(join(testDir, "minsky.json"), JSON.stringify(config, null, 2));

      // Mock results with 150 warnings (over 100 threshold)
      const warningResults: ESLintResult[] = [
        {
          filePath: "/mock/warnings.ts",
          messages: [],
          errorCount: 0,
          warningCount: 150,
          fixableErrorCount: 0,
          fixableWarningCount: 50,
        },
      ];

      mockExecAsync = mock(() =>
        Promise.resolve({
          stdout: JSON.stringify(warningResults),
          stderr: "",
        })
      );

      const result = await (hook as any).runESLintValidation();

      expect(result.success).toBe(false);
      expect(result.message).toContain("150 warnings (over 100 threshold)");
      expect(mockLog.cli).toHaveBeenCalledWith(
        "⚠️ ⚠️ ⚠️ TOO MANY WARNINGS! COMMIT BLOCKED! ⚠️ ⚠️ ⚠️"
      );
    });
  });

  describe("Console Validation", () => {
    it("should block commits with console violations", async () => {
      mockExecAsync = mock(() => Promise.reject(new Error("Console violations found")));

      const result = await (hook as any).runConsoleValidation();

      expect(result.success).toBe(false);
      expect(result.message).toBe("Console usage violations found");
      expect(mockLog.cli).toHaveBeenCalledWith(
        "❌ Console usage violations found! These cause test output pollution."
      );
    });

    it("should pass when no console violations", async () => {
      mockExecAsync = mock(() => Promise.resolve({ stdout: "", stderr: "" }));

      const result = await (hook as any).runConsoleValidation();

      expect(result.success).toBe(true);
      expect(result.message).toBe("Console validation passed");
    });
  });

  describe("Full Hook Integration", () => {
    it("should stop at first failure", async () => {
      // Mock secret scanning to fail (first step)
      mockExecAsync.mockImplementationOnce(() => Promise.reject(new Error("Secrets found")));

      const result = await hook.run();

      expect(result.success).toBe(false);
      expect(result.message).toBe("Secret scanning failed");

      // Should only call secret scanning, not continue
      expect(mockExecAsync).toHaveBeenCalledTimes(1);
    });

    it("should run all steps when everything passes", async () => {
      // Setup mock config
      const config = {
        workflows: {
          lint: { jsonCommand: "eslint . --format json" },
        },
      };
      mockFs.writeFileSync(join(testDir, "minsky.json"), JSON.stringify(config, null, 2));
      mockFs.writeFileSync(join(testDir, ".gitleaks.toml"), "# Mock config");

      // Mock all external commands to succeed
      mockExecAsync = mock(() =>
        Promise.resolve({
          stdout: "[]", // Empty ESLint results
          stderr: "",
        })
      );

      const result = await hook.run();

      expect(result.success).toBe(true);
      expect(result.message).toBe("All pre-commit checks passed");
      expect(mockLog.cli).toHaveBeenCalledWith("✅ All checks passed! Commit proceeding...");

      // Should call all 7 validation steps
      expect(mockExecAsync).toHaveBeenCalledTimes(7);
    });
  });
});

/**
 * Tests for Task 223 Enhanced Error Message Templates
 * 
 * This test suite verifies that the enhanced error messages provide clear,
 * actionable feedback for the specific error scenarios identified in Task 209.
 */

import { describe, test, expect } from "bun:test";
import {
  createSessionPrBranchErrorMessage,
  createTaskIdParsingErrorMessage,
  createVariableNamingErrorMessage,
  createGitTimeoutErrorMessage,
  createMergeConflictErrorMessage,
  createBackendDetectionErrorMessage,
} from "../enhanced-error-templates";

describe("Task 223 Enhanced Error Messages", () => {
  describe("createSessionPrBranchErrorMessage", () => {
    test("should create helpful error message for PR branch restriction", () => {
      const result = createSessionPrBranchErrorMessage(
        "pr/task-123-feature",
        "task-123",
        [
          { label: "Current directory", value: "/Users/test/sessions/223" },
          { label: "Current branch", value: "pr/task-123-feature" }
        ]
      );

      expect(result)!.toContain("Cannot Run Session PR from PR Branch");
      expect(result)!.toContain("pr/task-123-feature");
      expect(result)!.toContain("git switch task-123");
      expect(result)!.toContain("git branch -a");
      expect(result)!.toContain("pwd | grep sessions");
    });

    test("should handle undefined session name gracefully", () => {
      const result = createSessionPrBranchErrorMessage(
        "pr/feature-branch",
        undefined,
        []
      );

      expect(result)!.toContain("Cannot Run Session PR from PR Branch");
      expect(result)!.toContain("pr/feature-branch");
      expect(result)!.toContain("git switch <session-branch>");
    });

    test("should include context information when provided", () => {
      const result = createSessionPrBranchErrorMessage(
        "pr/test",
        "test-session",
        [
          { label: "Working directory", value: "/path/to/session" },
          { label: "Git status", value: "clean" }
        ]
      );

      expect(result)!.toContain("Working directory: /path/to/session");
      expect(result)!.toContain("Git status: clean");
    });
  });

  describe("createTaskIdParsingErrorMessage", () => {
    test("should show supported task ID formats", () => {
      const result = createTaskIdParsingErrorMessage(
        "invalid-task-id",
        [
          { label: "Operation", value: "get task" },
          { label: "Input", value: "invalid-task-id" }
        ]
      );

      expect(result)!.toContain("Invalid Task ID Format");
      expect(result)!.toContain("invalid-task-id");
      expect(result)!.toContain("123");
      expect(result)!.toContain("#123");
      expect(result)!.toContain("077");
      expect(result)!.toContain("#077");
      expect(result)!.toContain("ABC123");
      expect(result)!.toContain("#ABC123");
      expect(result)!.toContain("minsky tasks get 123");
      expect(result)!.toContain("minsky tasks list");
    });

    test("should include operation context", () => {
      const result = createTaskIdParsingErrorMessage(
        "xyz",
        [
          { label: "Operation", value: "set task status" },
          { label: "Status", value: "DONE" }
        ]
      );

      expect(result)!.toContain("Operation: set task status");
      expect(result)!.toContain("Status: DONE");
    });
  });

  describe("createVariableNamingErrorMessage", () => {
    test("should identify underscore prefix mismatch (declaration has underscore, usage doesn't)", () => {
      const result = createVariableNamingErrorMessage(
        "taskId",
        "with_underscore",
        "without_underscore",
        "src/test.ts",
        10,
        15,
        []
      );

      expect(result)!.toContain("Variable Declaration/Usage Mismatch");
      expect(result)!.toContain("taskId");
      expect(result)!.toContain("declared with underscore prefix but used without underscore");
      expect(result)!.toContain("Remove underscore from declaration (line 10)");
      expect(result)!.toContain("const taskId = ...");
      expect(result)!.toContain("variable-naming-protocol.mdc");
    });

    test("should identify reverse underscore mismatch (declaration without underscore, usage has underscore)", () => {
      const result = createVariableNamingErrorMessage(
        "sessionName",
        "without_underscore",
        "with_underscore",
        "src/session.ts",
        20,
        25,
        []
      );

      expect(result)!.toContain("Variable Declaration/Usage Mismatch");
      expect(result)!.toContain("sessionName");
      expect(result)!.toContain("declared without underscore but used with underscore prefix");
      expect(result)!.toContain("Add underscore to declaration (line 20) or remove from usage (line 25)");
    });

    test("should include file path and line numbers when provided", () => {
      const result = createVariableNamingErrorMessage(
        "variable",
        "with_underscore",
        "without_underscore",
        "src/commands/task.ts",
        42,
        84,
        [{ label: "Function", value: "processTask" }]
      );

      expect(result)!.toContain("File: src/commands/task.ts");
      expect(result)!.toContain("Declaration line: 42");
      expect(result)!.toContain("Usage line: 84");
      expect(result)!.toContain("Function: processTask");
    });
  });

  describe("createGitTimeoutErrorMessage", () => {
    test("should provide troubleshooting steps for git timeouts", () => {
      const result = createGitTimeoutErrorMessage(
        "fetch",
        30000,
        "/path/to/repo",
        []
      );

      expect(result)!.toContain("Git Operation Timeout");
      expect(result)!.toContain("Git fetch operation timed out after 30 seconds");
      expect(result)!.toContain("ping -c 3 github.com");
      expect(result)!.toContain("git remote -v");
      expect(result)!.toContain("git config --global http.lowSpeedLimit 0");
      expect(result)!.toContain("git count-objects -v");
      expect(result)!.toContain("git fetch --verbose");
    });

    test("should include timeout duration in context", () => {
      const result = createGitTimeoutErrorMessage(
        "clone",
        120000,
        "/path/to/repo",
        [{ label: "Repository", value: "https://github.com/user/repo.git" }]
      );

      expect(result)!.toContain("Timeout: 120 seconds");
      expect(result)!.toContain("Working directory: /path/to/repo");
      expect(result)!.toContain("Repository: https://github.com/user/repo.git");
    });
  });

  describe("createMergeConflictErrorMessage", () => {
    test("should identify conflicting files with conflict types", () => {
      const conflictingFiles = ["src/file1.ts", "src/file2.ts", "README.md"];
      const conflictTypes = {
        "src/file1.ts": "modify/modify" as const,
        "src/file2.ts": "add/add" as const,
        "README.md": "delete/modify" as const
      };

      const result = createMergeConflictErrorMessage(
        "merge",
        conflictingFiles,
        conflictTypes,
        "/path/to/repo",
        []
      );

      expect(result)!.toContain("Merge Conflicts Detected");
      expect(result)!.toContain("failed due to conflicts in 3 file(s)");
      expect(result)!.toContain("✏️ src/file1.ts (modify/modify conflict)");
      expect(result)!.toContain("➕ src/file2.ts (add/add conflict)");
      expect(result)!.toContain("🗑️ README.md (delete/modify conflict)");
      expect(result)!.toContain("git status");
      expect(result)!.toContain("git mergetool");
      expect(result)!.toContain("git merge --continue");
    });

    test("should provide resolution strategies", () => {
      const result = createMergeConflictErrorMessage(
        "rebase",
        ["conflict.txt"],
        { "conflict.txt": "modify/modify" },
        "/repo",
        []
      );

      expect(result)!.toContain("git diff --name-only --diff-filter=U");
      expect(result)!.toContain("git checkout --theirs .");
      expect(result)!.toContain("git checkout --ours .");
      expect(result)!.toContain("git add .");
      expect(result)!.toContain("git rebase --continue");
    });
  });

  describe("createBackendDetectionErrorMessage", () => {
    test("should show available backends and their requirements", () => {
      const availableBackends = ["markdown", "json-file", "github-issues"];
      const requirements = {
        "github-issues": ["GitHub token", "Repository access"],
        "json-file": ["Write permissions"]
      };

      const result = createBackendDetectionErrorMessage(
        "auto-detect",
        availableBackends,
        requirements,
        "/path/to/workspace",
        []
      );

      expect(result)!.toContain("Backend Detection Failed");
      expect(result)!.toContain("Failed to configure or detect backend 'auto-detect'");
      expect(result)!.toContain("• markdown");
      expect(result)!.toContain("• json-file (requires: Write permissions)");
      expect(result)!.toContain("• github-issues (requires: GitHub token, Repository access)");
      expect(result)!.toContain("minsky config show");
      expect(result)!.toContain("minsky config set backend markdown");
      expect(result)!.toContain("minsky init --backend markdown");
    });

    test("should provide default backend list when no backends provided", () => {
      const result = createBackendDetectionErrorMessage(
        undefined,
        [],
        {},
        "/workspace",
        []
      );

      expect(result)!.toContain("Failed to automatically detect appropriate task backend");
      expect(result)!.toContain("• markdown (default)");
      expect(result)!.toContain("• json-file");
      expect(result)!.toContain("• github-issues (requires GitHub config)");
    });

    test("should include workspace path in context", () => {
      const result = createBackendDetectionErrorMessage(
        "custom-backend",
        ["markdown"],
        {},
        "/Users/test/project",
        [{ label: "Config file", value: ".minsky/config.json" }]
      );

      expect(result)!.toContain("Workspace path: /Users/test/project");
      expect(result)!.toContain("Config file: .minsky/config.json");
    });
  });

  describe("Error Message Quality", () => {
    test("should use consistent emoji patterns across all error types", () => {
      const sessionPrError = createSessionPrBranchErrorMessage("pr/test", "test", []);
      const taskIdError = createTaskIdParsingErrorMessage("invalid", []);
      const variableError = createVariableNamingErrorMessage("var", "with_underscore", "without_underscore", "file.ts", 1, 2, []);
      const gitError = createGitTimeoutErrorMessage("fetch", 30000, "/repo", []);
      const mergeError = createMergeConflictErrorMessage("merge", ["file.txt"], { "file.txt": "modify/modify" }, "/repo", []);
      const backendError = createBackendDetectionErrorMessage("test", ["markdown"], {}, "/workspace", []);

      // All error messages should have consistent formatting
      expect(sessionPrError)!.toMatch(/^🚫/);
      expect(taskIdError)!.toMatch(/^❌/);
      expect(variableError).toMatch(/^❌/);
      expect(gitError).toMatch(/^⚠️/);
      expect(mergeError).toMatch(/^💥/);
      expect(backendError)!.toMatch(/^❌/);
    });

    test("should provide actionable command suggestions", () => {
      const error = createTaskIdParsingErrorMessage("xyz", []);
      
      // Should contain specific commands users can run
      expect(error as Error).toMatch(/minsky tasks get \d+/);
      expect(error as Error).toMatch(/minsky tasks list/);
      
      // Commands should be preceded by emojis for consistency
      const hasCommandEmoji = error.includes("⚡") && error.includes("minsky tasks");
      const hasListEmoji = error.includes("📋") && error.includes("minsky tasks");
      expect(hasCommandEmoji || hasListEmoji).toBe(true);
    });

    test("should include context information when provided", () => {
      const context = [
        { label: "File", value: "/path/to/file.ts" },
        { label: "Line", value: "42" },
        { label: "Function", value: "processTask" }
      ];

      const error = createVariableNamingErrorMessage(
        "variable",
        "with_underscore",
        "without_underscore",
        "file.ts",
        10,
        20,
        context
      );

      expect(error as Error).toContain("File: /path/to/file.ts");
      expect(error as Error).toContain("Line: 42");
      expect(error as Error).toContain("Function: processTask");
    });
  });
}); 

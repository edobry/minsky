/**
 * Tests for Enhanced Git Execution Utility with Task 223 Timeout Handling
 *
 * This test suite verifies that the enhanced git execution utility provides proper
 * timeout handling and enhanced error messages for git operations.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { createMock, mockModule } from "./test-utils/mocking";
import {
  execGitWithTimeout,
  gitCloneWithTimeout,
  gitFetchWithTimeout,
  gitPushWithTimeout,
  gitPullWithTimeout,
  gitMergeWithTimeout,
  type GitExecOptions,
  type GitExecResult,
} from "./git-exec-enhanced";
import { MinskyError } from "../errors/base-errors";

// Mock the exec function from child_process
const mockExec = createMock();
const mockExecAsync = createMock();

// Mock the child_process module
mockModule("child_process", () => ({
  exec: mockExec,
}));

// Mock the util module to return our mocked execAsync
mockModule("util", () => ({
  promisify: createMock(() => mockExecAsync),
}));

interface ExtendedError extends Error {
  killed?: boolean;
  signal?: string;
  stdout?: string;
  stderr?: string;
  code?: number;
}

describe("Enhanced Git Execution Utility", () => {
  beforeEach(() => {
    mockExecAsync.mockClear();
    mockExec.mockClear();
  });

  describe("execGitWithTimeout", () => {
    test("should execute git command successfully", async () => {
      const mockResult = {
        stdout: "Command output",
        stderr: "Command stderr",
      };
      mockExecAsync.mockResolvedValue(mockResult);

      const result = await execGitWithTimeout("fetch", "fetch origin", {
        workdir: "/test/repo",
        timeout: 5000,
        context: [{ label: "Remote", value: "origin" }],
      });

      expect(result).toEqual({
        stdout: "Command output",
        stderr: "Command stderr",
        command: "git -C /test/repo fetch origin",
        workdir: "/test/repo",
        executionTimeMs: expect.any(Number),
      });

      expect(mockExecAsync).toHaveBeenCalledWith("git -C /test/repo fetch origin", {
        timeout: 5000,
        cwd: "/test/repo",
      });
    });

    test("should handle timeout errors with enhanced error messages", async () => {
      const timeoutError: ExtendedError = new Error("Command timed out");
      timeoutError.killed = true;
      timeoutError.signal = "SIGTERM";
      mockExecAsync.mockRejectedValue(timeoutError);

      try {
        await execGitWithTimeout("fetch", "fetch origin", {
          workdir: "/test/repo",
          timeout: 5000,
        });
        expect.unreachable("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(MinskyError);
        expect(error.message).toContain("Git Operation Timeout");
        expect(error.message).toContain("Git fetch operation timed out after 5 seconds");
        expect(error.message).toContain("git -C /test/repo fetch origin");
      }
    });

    test("should handle merge conflicts with enhanced error messages", async () => {
      const conflictError: ExtendedError = new Error("Merge conflict");
      conflictError.stdout =
        "CONFLICT (content): Merge conflict in file1.txt\nCONFLICT (add/add): Merge conflict in file2.txt";
      conflictError.stderr = "CONFLICT (modify/delete): file3.txt";
      mockExecAsync.mockRejectedValue(conflictError);

      try {
        await execGitWithTimeout("merge", "merge feature-branch", {
          workdir: "/test/repo",
        });
        expect.unreachable("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(MinskyError);
        expect(error.message).toContain("Merge Conflicts Detected");
        expect(error.message).toContain("file1.txt");
        expect(error.message).toContain("file2.txt");
        expect(error.message).toContain("file3.txt");
      }
    });

    test("should handle other git errors with enhanced context", async () => {
      const gitError: ExtendedError = new Error("Git command failed");
      gitError.code = 1;
      mockExecAsync.mockRejectedValue(gitError);

      try {
        await execGitWithTimeout("push", "push origin main", {
          workdir: "/test/repo",
          timeout: 10000,
        });
        expect.unreachable("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(MinskyError);
        expect(error.message).toContain("Git push failed");
        expect(error.message).toContain("git -C /test/repo push origin main");
        expect(error.message).toContain("Working directory: /test/repo");
        expect(error.message).toContain("Execution time:");
      }
    });

    test("should work without workdir specified", async () => {
      const mockResult = {
        stdout: "Command output",
        stderr: "",
      };
      mockExecAsync.mockResolvedValue(mockResult);

      const result = await execGitWithTimeout("status", "status", {
        timeout: 5000,
      });

      expect(result.command).toBe("git status");
      expect(result.workdir).toBeUndefined();
      expect(mockExecAsync).toHaveBeenCalledWith("git status", {
        timeout: 5000,
      });
    });

    test("should use default timeout when not specified", async () => {
      const mockResult = {
        stdout: "Command output",
        stderr: "",
      };
      mockExecAsync.mockResolvedValue(mockResult);

      await execGitWithTimeout("status", "status");

      expect(mockExecAsync).toHaveBeenCalledWith("git status", {
        timeout: 30000, // Default timeout
      });
    });
  });

  describe("gitCloneWithTimeout", () => {
    test("should execute git clone with correct parameters", async () => {
      const mockResult = {
        stdout: "Cloning into 'repo'...",
        stderr: "",
      };
      mockExecAsync.mockResolvedValue(mockResult);

      const result = await gitCloneWithTimeout(
        "https://github.com/user/repo.git",
        "/path/to/clone",
        {
          timeout: 60000,
          context: [{ label: "Project", value: "test-project" }],
        }
      );

      expect(result.command).toBe("git clone https://github.com/user/repo.git /path/to/clone");
      expect(mockExecAsync).toHaveBeenCalledWith(
        "git clone https://github.com/user/repo.git /path/to/clone",
        {
          timeout: 60000,
        }
      );
    });
  });

  describe("gitFetchWithTimeout", () => {
    test("should execute git fetch with default remote", async () => {
      const mockResult = {
        stdout: "Fetching origin...",
        stderr: "",
      };
      mockExecAsync.mockResolvedValue(mockResult);

      const result = await gitFetchWithTimeout("origin", undefined, {
        workdir: "/test/repo",
        timeout: 30000,
      });

      expect(result.command).toBe("git -C /test/repo fetch origin");
      expect(mockExecAsync).toHaveBeenCalledWith("git -C /test/repo fetch origin", {
        timeout: 30000,
        cwd: "/test/repo",
      });
    });

    test("should execute git fetch with specific remote and branch", async () => {
      const mockResult = {
        stdout: "Fetching upstream...",
        stderr: "",
      };
      mockExecAsync.mockResolvedValue(mockResult);

      const result = await gitFetchWithTimeout("upstream", "main", {
        workdir: "/test/repo",
        timeout: 30000,
      });

      expect(result.command).toBe("git -C /test/repo fetch upstream main");
      expect(mockExecAsync).toHaveBeenCalledWith("git -C /test/repo fetch upstream main", {
        timeout: 30000,
        cwd: "/test/repo",
      });
    });
  });

  describe("gitPushWithTimeout", () => {
    test("should execute git push with default remote", async () => {
      const mockResult = {
        stdout: "Pushing to origin...",
        stderr: "",
      };
      mockExecAsync.mockResolvedValue(mockResult);

      const result = await gitPushWithTimeout("origin", undefined, {
        workdir: "/test/repo",
        timeout: 30000,
      });

      expect(result.command).toBe("git -C /test/repo push origin");
      expect(mockExecAsync).toHaveBeenCalledWith("git -C /test/repo push origin", {
        timeout: 30000,
        cwd: "/test/repo",
      });
    });

    test("should execute git push with specific remote and branch", async () => {
      const mockResult = {
        stdout: "Pushing to upstream...",
        stderr: "",
      };
      mockExecAsync.mockResolvedValue(mockResult);

      const result = await gitPushWithTimeout("upstream", "feature-branch", {
        workdir: "/test/repo",
        timeout: 30000,
      });

      expect(result.command).toBe("git -C /test/repo push upstream feature-branch");
      expect(mockExecAsync).toHaveBeenCalledWith("git -C /test/repo push upstream feature-branch", {
        timeout: 30000,
        cwd: "/test/repo",
      });
    });
  });

  describe("gitPullWithTimeout", () => {
    test("should execute git pull with default remote", async () => {
      const mockResult = {
        stdout: "Pulling from origin...",
        stderr: "",
      };
      mockExecAsync.mockResolvedValue(mockResult);

      const result = await gitPullWithTimeout("origin", undefined, {
        workdir: "/test/repo",
        timeout: 30000,
      });

      expect(result.command).toBe("git -C /test/repo pull origin");
      expect(mockExecAsync).toHaveBeenCalledWith("git -C /test/repo pull origin", {
        timeout: 30000,
        cwd: "/test/repo",
      });
    });
  });

  describe("gitMergeWithTimeout", () => {
    test("should execute git merge with specified branch", async () => {
      const mockResult = {
        stdout: "Merging feature-branch...",
        stderr: "",
      };
      mockExecAsync.mockResolvedValue(mockResult);

      const result = await gitMergeWithTimeout("feature-branch", {
        workdir: "/test/repo",
        timeout: 30000,
      });

      expect(result.command).toBe("git -C /test/repo merge feature-branch");
      expect(mockExecAsync).toHaveBeenCalledWith("git -C /test/repo merge feature-branch", {
        timeout: 30000,
        cwd: "/test/repo",
      });
    });
  });

  describe("Error Message Quality", () => {
    test("should include execution time in all error messages", async () => {
      const gitError = new Error("Git command failed");
      mockExecAsync.mockRejectedValue(gitError);

      try {
        await execGitWithTimeout("status", "status", {
          workdir: "/test/repo",
          timeout: 5000,
        });
        expect.unreachable("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(MinskyError);
        expect(error.message).toContain("Git status failed");
        expect(error.message).toMatch(/\d+ms/);
      }
    });

    test("should include full command in error messages", async () => {
      const gitError = new Error("Git command failed");
      mockExecAsync.mockRejectedValue(gitError);

      try {
        await execGitWithTimeout("push", "push origin main", {
          workdir: "/test/repo",
          timeout: 5000,
        });
        expect.unreachable("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(MinskyError);
        expect(error.message).toContain("Git push failed");
        expect(error.message).toContain("git -C /test/repo push origin main");
      }
    });

    test("should include context information in error messages", async () => {
      const gitError = new Error("Git command failed");
      mockExecAsync.mockRejectedValue(gitError);

      try {
        await execGitWithTimeout("push", "push origin main", {
          workdir: "/test/repo",
          timeout: 5000,
          context: [{ label: "Remote", value: "origin" }],
        });
        expect.unreachable("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(MinskyError);
        expect(error.message).toContain("Git push failed");
        expect(error.message).toContain("git -C /test/repo push origin main");
        expect(error.message).toContain("Working directory: /test/repo");
        expect(error.message).toContain("Execution time:");
      }
    });
  });

  describe("Conflict Detection", () => {
    test("should detect different types of merge conflicts", async () => {
      const conflictError: ExtendedError = new Error("Merge conflict");
      conflictError.stdout = `
        CONFLICT (content): Merge conflict in src/file1.js
        CONFLICT (add/add): Merge conflict in src/file2.js
        CONFLICT (modify/delete): src/file3.js deleted in HEAD and modified in feature-branch
      `;
      conflictError.stderr = "";
      mockExecAsync.mockRejectedValue(conflictError);

      try {
        await execGitWithTimeout("merge", "merge feature-branch", {
          workdir: "/test/repo",
        });
        expect.unreachable("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(MinskyError);
        expect(error.message).toContain("Merge Conflicts Detected");
        expect(error.message).toContain("✏️ src/file1.js (modify/modify conflict)");
        expect(error.message).toContain("➕ src/file2.js (add/add conflict)");
        expect(error.message).toContain("🗑️ src/file3.js (delete/modify conflict)");
      }
    });

    test("should provide resolution strategies for merge conflicts", async () => {
      const conflictError: ExtendedError = new Error("Merge conflict");
      conflictError.stdout = "CONFLICT (content): Merge conflict in test.txt";
      conflictError.stderr = "";
      mockExecAsync.mockRejectedValue(conflictError);

      try {
        await execGitWithTimeout("merge", "merge feature-branch", {
          workdir: "/test/repo",
        });
        expect.unreachable("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(MinskyError);
        expect(error.message).toContain("Merge Conflicts Detected");
        expect(error.message).toContain("git status");
        expect(error.message).toContain("git mergetool");
        expect(error.message).toContain("git merge --continue");
      }
    });
  });
});

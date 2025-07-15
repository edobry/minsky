/**
 * Tests for Git Execution Utility
 *
 * This test suite verifies that the git execution utility provides proper
 * timeout handling and contextual error messages for git operations.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { MinskyError } from "../errors/base-errors";

// Create mock for child_process exec
const mockExec = mock();

// Mock child_process module
mock.module("child_process", () => ({
  exec: mockExec,
}));

// Import after mocking
import {
  execGitWithTimeout,
  gitCloneWithTimeout,
  gitFetchWithTimeout,
  gitPushWithTimeout,
  gitPullWithTimeout,
  gitMergeWithTimeout,
  type GitExecOptions,
  type GitExecResult,
} from "./git-exec";

interface ExtendedError extends Error {
  killed?: boolean;
  signal?: string;
  stdout?: string;
  stderr?: string;
  code?: number;
}

describe("Git Execution Utility", () => {
  beforeEach(() => {
    mockExec.mockClear();
  });

  describe("execGitWithTimeout", () => {
    test("should execute git command successfully", async () => {
      const mockResult = {
        stdout: "Command output",
        stderr: "Command stderr",
      };
      
      // Mock exec to call the callback with success
      mockExec.mockImplementation((command: string, options: any, callback: any) => {
        callback(null, mockResult.stdout, mockResult.stderr);
      });

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

      expect(mockExec).toHaveBeenCalledWith("git -C /test/repo fetch origin", {
        timeout: 5000,
        cwd: "/test/repo",
      }, expect.any(Function));
    });

    test("should handle timeout errors with enhanced error messages", async () => {
      const timeoutError: ExtendedError = new Error("Command timed out");
      timeoutError.killed = true;
      timeoutError.signal = "SIGTERM";

      // Mock exec to call the callback with timeout error
      mockExec.mockImplementation((command: string, options: any, callback: any) => {
        callback(timeoutError);
      });

      try {
        await execGitWithTimeout("fetch", "fetch origin", {
          workdir: "/test/repo",
          timeout: 5000,
        });
        expect.unreachable("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(MinskyError);
        expect((error as MinskyError).message).toContain("Git Operation Timeout");
        expect((error as MinskyError).message).toContain("git -C /test/repo fetch origin");
      }
    });

    test("should handle merge conflicts with enhanced error messages", async () => {
      const conflictError: ExtendedError = new Error("Merge conflict");
      conflictError.stdout = "CONFLICT (content): Merge conflict in file1.txt\nCONFLICT (add/add): Merge conflict in file2.txt";
      conflictError.stderr = "CONFLICT (modify/delete): file3.txt";

      // Mock exec to call the callback with conflict error
      mockExec.mockImplementation((command: string, options: any, callback: any) => {
        callback(conflictError);
      });

      try {
        await execGitWithTimeout("merge", "merge feature-branch", {
          workdir: "/test/repo",
        });
        expect.unreachable("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(MinskyError);
        expect((error as MinskyError).message).toContain("Merge Conflicts Detected");
        expect((error as MinskyError).message).toContain("file1.txt");
        expect((error as MinskyError).message).toContain("file2.txt");
        expect((error as MinskyError).message).toContain("file3.txt");
      }
    });

    test("should handle other git errors with enhanced context", async () => {
      const gitError: ExtendedError = new Error("Git command failed");
      gitError.code = 1;

      // Mock exec to call the callback with generic error
      mockExec.mockImplementation((command: string, options: any, callback: any) => {
        callback(gitError);
      });

      try {
        await execGitWithTimeout("push", "push origin main", {
          workdir: "/test/repo",
        });
        expect.unreachable("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(MinskyError);
        expect((error as MinskyError).message).toContain("Git push failed");
        expect((error as MinskyError).message).toContain("git -C /test/repo push origin main");
      }
    });

    test("should work without workdir specified", async () => {
      const mockResult = {
        stdout: "status output",
        stderr: "",
      };
      
      // Mock exec to call the callback with success
      mockExec.mockImplementation((command: string, options: any, callback: any) => {
        callback(null, mockResult.stdout, mockResult.stderr);
      });

      const result = await execGitWithTimeout("status", "status", {
        timeout: 5000,
      });

      expect(result.command).toBe("git status");
      expect(result.workdir).toBeUndefined();
      expect(mockExec).toHaveBeenCalledWith("git status", {
        timeout: 5000,
      }, expect.any(Function));
    });

    test("should use default timeout when not specified", async () => {
      const mockResult = {
        stdout: "status output",
        stderr: "",
      };
      
      // Mock exec to call the callback with success
      mockExec.mockImplementation((command: string, options: any, callback: any) => {
        callback(null, mockResult.stdout, mockResult.stderr);
      });

      await execGitWithTimeout("status", "status");

      expect(mockExec).toHaveBeenCalledWith("git status", {
        timeout: 30000,
      }, expect.any(Function));
    });
  });

  describe("gitCloneWithTimeout", () => {
    test("should execute git clone with correct parameters", async () => {
      const mockResult = {
        stdout: "Cloning into...",
        stderr: "",
      };
      
      // Mock exec to call the callback with success
      mockExec.mockImplementation((command: string, options: any, callback: any) => {
        callback(null, mockResult.stdout, mockResult.stderr);
      });

      const result = await gitCloneWithTimeout("https://github.com/user/repo.git", "/path/to/clone");

      expect(result.command).toBe("git clone https://github.com/user/repo.git /path/to/clone");
      expect(result.stdout).toBe("Cloning into...");
      expect(mockExec).toHaveBeenCalledWith("git clone https://github.com/user/repo.git /path/to/clone", {
        timeout: 30000,
      }, expect.any(Function));
    });
  });

  describe("gitFetchWithTimeout", () => {
    test("should execute git fetch with default remote", async () => {
      const mockResult = {
        stdout: "Fetching origin...",
        stderr: "",
      };
      
      // Mock exec to call the callback with success
      mockExec.mockImplementation((command: string, options: any, callback: any) => {
        callback(null, mockResult.stdout, mockResult.stderr);
      });

      const result = await gitFetchWithTimeout("origin", undefined, { workdir: "/test/repo" });

      expect(result.command).toBe("git -C /test/repo fetch origin");
      expect(result.workdir).toBe("/test/repo");
      expect(mockExec).toHaveBeenCalledWith("git -C /test/repo fetch origin", {
        timeout: 30000,
        cwd: "/test/repo",
      }, expect.any(Function));
    });

    test("should execute git fetch with specific remote and branch", async () => {
      const mockResult = {
        stdout: "Fetching upstream...",
        stderr: "",
      };
      
      // Mock exec to call the callback with success
      mockExec.mockImplementation((command: string, options: any, callback: any) => {
        callback(null, mockResult.stdout, mockResult.stderr);
      });

      const result = await gitFetchWithTimeout("upstream", "main", { workdir: "/test/repo" });

      expect(result.command).toBe("git -C /test/repo fetch upstream main");
      expect(result.workdir).toBe("/test/repo");
      expect(mockExec).toHaveBeenCalledWith("git -C /test/repo fetch upstream main", {
        timeout: 30000,
        cwd: "/test/repo",
      }, expect.any(Function));
    });
  });

  describe("gitPushWithTimeout", () => {
    test("should execute git push with default remote", async () => {
      const mockResult = {
        stdout: "Pushing to origin...",
        stderr: "",
      };
      
      // Mock exec to call the callback with success
      mockExec.mockImplementation((command: string, options: any, callback: any) => {
        callback(null, mockResult.stdout, mockResult.stderr);
      });

      const result = await gitPushWithTimeout("origin", undefined, { workdir: "/test/repo" });

      expect(result.command).toBe("git -C /test/repo push origin");
      expect(result.workdir).toBe("/test/repo");
      expect(mockExec).toHaveBeenCalledWith("git -C /test/repo push origin", {
        timeout: 30000,
        cwd: "/test/repo",
      }, expect.any(Function));
    });

    test("should execute git push with specific remote and branch", async () => {
      const mockResult = {
        stdout: "Pushing to upstream...",
        stderr: "",
      };
      
      // Mock exec to call the callback with success
      mockExec.mockImplementation((command: string, options: any, callback: any) => {
        callback(null, mockResult.stdout, mockResult.stderr);
      });

      const result = await gitPushWithTimeout("upstream", "feature-branch", { workdir: "/test/repo" });

      expect(result.command).toBe("git -C /test/repo push upstream feature-branch");
      expect(result.workdir).toBe("/test/repo");
      expect(mockExec).toHaveBeenCalledWith("git -C /test/repo push upstream feature-branch", {
        timeout: 30000,
        cwd: "/test/repo",
      }, expect.any(Function));
    });
  });

  describe("gitPullWithTimeout", () => {
    test("should execute git pull with default remote", async () => {
      const mockResult = {
        stdout: "Pulling from origin...",
        stderr: "",
      };
      
      // Mock exec to call the callback with success
      mockExec.mockImplementation((command: string, options: any, callback: any) => {
        callback(null, mockResult.stdout, mockResult.stderr);
      });

      const result = await gitPullWithTimeout("origin", undefined, { workdir: "/test/repo" });

      expect(result.command).toBe("git -C /test/repo pull origin");
      expect(result.workdir).toBe("/test/repo");
      expect(mockExec).toHaveBeenCalledWith("git -C /test/repo pull origin", {
        timeout: 30000,
        cwd: "/test/repo",
      }, expect.any(Function));
    });
  });

  describe("gitMergeWithTimeout", () => {
    test("should execute git merge with specified branch", async () => {
      const mockResult = {
        stdout: "Merging feature-branch...",
        stderr: "",
      };
      
      // Mock exec to call the callback with success
      mockExec.mockImplementation((command: string, options: any, callback: any) => {
        callback(null, mockResult.stdout, mockResult.stderr);
      });

      const result = await gitMergeWithTimeout("feature-branch", { workdir: "/test/repo" });

      expect(result.command).toBe("git -C /test/repo merge feature-branch");
      expect(result.workdir).toBe("/test/repo");
      expect(mockExec).toHaveBeenCalledWith("git -C /test/repo merge feature-branch", {
        timeout: 30000,
        cwd: "/test/repo",
      }, expect.any(Function));
    });
  });

  describe("Error Message Quality", () => {
    test("should include execution time in all error messages", async () => {
      const gitError = new Error("Git command failed");

      // Mock exec to call the callback with error
      mockExec.mockImplementation((command: string, options: any, callback: any) => {
        callback(gitError);
      });

      try {
        await execGitWithTimeout("status", "status", {
          workdir: "/test/repo",
        });
        expect.unreachable("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(MinskyError);
        expect((error as MinskyError).message).toMatch(/\d+ms/);
      }
    });

    test("should include full command in error messages", async () => {
      const gitError = new Error("Git command failed");

      // Mock exec to call the callback with error
      mockExec.mockImplementation((command: string, options: any, callback: any) => {
        callback(gitError);
      });

      try {
        await execGitWithTimeout("push", "push origin main", {
          workdir: "/test/repo",
        });
        expect.unreachable("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(MinskyError);
        expect((error as MinskyError).message).toContain("git -C /test/repo push origin main");
      }
    });

    test("should include context information in error messages", async () => {
      const gitError = new Error("Git command failed");

      // Mock exec to call the callback with error
      mockExec.mockImplementation((command: string, options: any, callback: any) => {
        callback(gitError);
      });

      try {
        await execGitWithTimeout("push", "push origin main", {
          workdir: "/test/repo",
          context: [
            { label: "Branch", value: "main" },
            { label: "Remote", value: "origin" },
          ],
        });
        expect.unreachable("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(MinskyError);
        expect((error as MinskyError).message).toContain("Branch: main");
        expect((error as MinskyError).message).toContain("Remote: origin");
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

      // Mock exec to call the callback with conflict error
      mockExec.mockImplementation((command: string, options: any, callback: any) => {
        callback(conflictError);
      });

      try {
        await execGitWithTimeout("merge", "merge feature-branch", {
          workdir: "/test/repo",
        });
        expect.unreachable("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(MinskyError);
        expect((error as MinskyError).message).toContain("Merge Conflicts Detected");
        expect((error as MinskyError).message).toContain("📝 src/file1.js (content conflict)");
        expect((error as MinskyError).message).toContain("➕ src/file2.js (add/add conflict)");
        expect((error as MinskyError).message).toContain("🗑️ src/file3.js (delete/modify conflict)");
      }
    });

    test("should provide resolution strategies for merge conflicts", async () => {
      const conflictError: ExtendedError = new Error("Merge conflict");
      conflictError.stdout = "CONFLICT (content): Merge conflict in test.txt";
      conflictError.stderr = "";

      // Mock exec to call the callback with conflict error
      mockExec.mockImplementation((command: string, options: any, callback: any) => {
        callback(conflictError);
      });

      try {
        await execGitWithTimeout("merge", "merge feature-branch", {
          workdir: "/test/repo",
        });
        expect.unreachable("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(MinskyError);
        expect((error as MinskyError).message).toContain("Merge Conflicts Detected");
        expect((error as MinskyError).message).toContain("Resolution Steps:");
        expect((error as MinskyError).message).toContain("git status");
        expect((error as MinskyError).message).toContain("git add");
        expect((error as MinskyError).message).toContain("git commit");
      }
    });
  });
});

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { setupTestMocks, createMock } from "../../../../utils/test-utils/mocking";
import { FileSystemTestCleanup } from "../../../../utils/test-utils/cleanup-patterns";
import {
  cloneFromParams,
  branchFromParams,
  commitChangesFromParams,
  pushFromParams,
  mergeFromParams,
  checkoutFromParams,
  rebaseFromParams,
  createPullRequestFromParams,
} from "../index";

// Mock node:child_process exec which is what GitService actually uses
const mockExec = createMock() as any;
mock.module("node:child_process", () => ({
  exec: mockExec,
}));

// Mock promisify to return our mock exec function
const mockPromisify = createMock() as any;
mock.module("node:util", () => ({
  promisify: mockPromisify,
}));

setupTestMocks();

describe("Git Commands Integration Tests", () => {
  let fsCleanup: FileSystemTestCleanup;
  let tempWorkdir: string;

  beforeEach(() => {
    // Set up proper temporary directory management
    fsCleanup = new FileSystemTestCleanup();
    tempWorkdir = fsCleanup.createTempDir("git-test-workdir");
    
    // Set up mock implementations
    mockExec.mockReset();
    mockPromisify.mockReturnValue(mockExec);
    
    // CRITICAL: Completely mock all git operations to prevent real execution
    mockExec.mockImplementation((command: string, options: any, callback: any) => {
      // Handle both callback patterns: (command, callback) and (command, options, callback)
      const actualCallback = typeof options === "function" ? options : callback;
      
      // Mock successful responses for all git commands
      if (command.includes("git clone")) {
        actualCallback(null, { stdout: "Cloning into directory...", stderr: "" });
      } else if (command.includes("git rev-parse")) {
        actualCallback(null, { stdout: "abc123", stderr: "" });
      } else if (command.includes("git add")) {
        actualCallback(null, { stdout: "", stderr: "" });
      } else if (command.includes("git commit")) {
        actualCallback(null, { stdout: "[main abc123] Test commit", stderr: "" });
      } else if (command.includes("git push")) {
        actualCallback(null, { stdout: "Everything up-to-date", stderr: "" });
      } else if (command.includes("git checkout")) {
        actualCallback(null, { stdout: "Switched to branch", stderr: "" });
      } else if (command.includes("git merge")) {
        actualCallback(null, { stdout: "Already up to date", stderr: "" });
      } else if (command.includes("git rebase")) {
        actualCallback(null, { stdout: "Successfully rebased", stderr: "" });
      } else if (command.includes("git status")) {
        actualCallback(null, { stdout: "", stderr: "" });
      } else {
        // Default successful response for any other git command
        actualCallback(null, { stdout: "Success", stderr: "" });
      }
    });
  });

  afterEach(() => {
    // Clean up temporary directories
    fsCleanup.cleanup();
  });

  describe("cloneFromParams", () => {
    test("should clone repository successfully", async () => {
      const params = {
        url: "https://github.com/test/repo.git",
        workdir: tempWorkdir,
        session: "test-session"
      };

      const result = await cloneFromParams(params);

      expect(result.workdir).toBe(tempWorkdir);
      expect(result.session).toBe("test-session");
    });
  });

  describe("branchFromParams", () => {
    test("should create branch successfully", async () => {
      const params = {
        session: "test-session",
        name: "feature-branch"
      };

      const result = await branchFromParams(params);

      expect(result.branch).toBe("feature-branch");
    });
  });

  describe("commitChangesFromParams", () => {
    test("should commit changes successfully", async () => {
      mockExec.mockImplementation((command: string, callback: any) => {
        if (command.includes("git commit")) {
          callback(null, "abc123", "");
        } else {
          callback(null, "Command successful", "");
        }
      });

      const params = {
        repo: tempWorkdir,
        message: "Test commit",
        all: true
      };

      const result = await commitChangesFromParams(params);

      expect(result.commitHash).toBe("abc123");
    });
  });

  describe("pushFromParams", () => {
    test("should push changes successfully", async () => {
      const params = {
        repo: tempWorkdir,
        remote: "origin"
      };

      const result = await pushFromParams(params);

      expect(result.pushed).toBe(true);
    });
  });

  describe("mergeFromParams", () => {
    test("should merge changes successfully", async () => {
      const params = {
        repo: tempWorkdir,
        sourceBranch: "feature-branch",
        targetBranch: "main"
      };

      const result = await mergeFromParams(params);

      expect(result.merged).toBe(true);
    });
  });

  describe("checkoutFromParams", () => {
    test("should checkout branch successfully", async () => {
      const params = {
        branch: "main",
        repo: tempWorkdir
      };

      const result = await checkoutFromParams(params);

      expect(result.workdir).toBe(tempWorkdir);
      expect(result.switched).toBe(true);
    });
  });

  describe("rebaseFromParams", () => {
    test("should rebase changes successfully", async () => {
      const params = {
        baseBranch: "main",
        repo: tempWorkdir
      };

      const result = await rebaseFromParams(params);

      expect(result.rebased).toBe(true);
    });
  });

  describe("createPullRequestFromParams", () => {
    test("should generate PR successfully", async () => {
      mockExec.mockImplementation(async (command: string) => {
        if (command.includes("git log --oneline")) {
          return { stdout: "abc123 feat: add new feature", stderr: "" };
        }
        if (command.includes("git diff --name-only")) {
          return { stdout: "src/feature.ts", stderr: "" };
        }
        if (command.includes("git branch --show-current")) {
          return { stdout: "feature-branch", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });

      const params = {
        repo: tempWorkdir,
        branch: "feature-branch"
      };

      const result = await createPullRequestFromParams(params);

      expect(result.markdown).toContain("feature-branch");
    });
  });

  describe("Command Integration", () => {
    test("should execute a complete workflow", async () => {
      // Mock sequence of git operations
      mockExec.mockImplementation(async (command: string) => {
        if (command.includes("git clone")) {
          return { stdout: "Cloning...", stderr: "" };
        }
        if (command.includes("git checkout -b") || command.includes("git switch -c")) {
          return { stdout: "Switched to new branch", stderr: "" };
        }
        if (command.includes("git add")) {
          return { stdout: "", stderr: "" };
        }
        if (command.includes("git commit")) {
          return { stdout: "abc123", stderr: "" };
        }
        if (command.includes("git push")) {
          return { stdout: "Pushed", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      });

      // 1. Clone repository
      const cloneResult = await cloneFromParams({
        url: "https://github.com/test/repo.git",
        workdir: tempWorkdir,
        session: "test-session"
      });

      // 2. Create branch
      const branchResult = await branchFromParams({
        session: "test-session",
        name: "feature-branch"
      });

      // 3. Commit changes
      const commitResult = await commitChangesFromParams({
        repo: cloneResult.workdir,
        message: "Add feature",
        all: true
      });

      // 4. Push changes
      const pushResult = await pushFromParams({
        repo: cloneResult.workdir,
        remote: "origin"
      });

      // Verify the workflow completed successfully
      expect(cloneResult.session).toBe("test-session");
      expect(branchResult.branch).toBe("feature-branch");
      expect(commitResult.commitHash).toBe("abc123");
      expect(pushResult.pushed).toBe(true);
    });
  });
}); 

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { setupTestMocks, createMock } from "../../../../utils/test-utils/mocking";
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

// Mock the centralized execAsync module at the top level for proper module interception
const mockExecAsync = createMock() as any;
mock.module("../../../../utils/exec", () => ({
  execAsync: mockExecAsync,
}));

// Mock node:child_process exec to prevent real git commands
const mockExec = createMock() as any;
mock.module("node:child_process", () => ({
  exec: mockExec,
  promisify: (fn: any) => mockExecAsync, // Return our mock when promisify is called on exec
}));

setupTestMocks();

describe("Git Commands Integration Tests", () => {
  beforeEach(() => {
    // Reset mock implementations
    mockExecAsync.mockReset();
    mockExecAsync.mockResolvedValue({ stdout: "success", stderr: "" });
  });

  describe("cloneFromParams", () => {
    test("should clone repository successfully", async () => {
      const params = {
        url: "https://github.com/test/repo.git",
        workdir: "/test/workdir",
        session: "test-session"
      };

      const result = await cloneFromParams(params);

      expect(result.workdir).toBe("/test/workdir");
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
      mockExecAsync.mockResolvedValue({ stdout: "abc123", stderr: "" });

      const params = {
        repo: "/test/workdir",
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
        repo: "/test/workdir",
        remote: "origin"
      };

      const result = await pushFromParams(params);

      expect(result.pushed).toBe(true);
    });
  });

  describe("mergeFromParams", () => {
    test("should merge changes successfully", async () => {
      const params = {
        repo: "/test/workdir",
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
        repo: "/test/workdir"
      };

      const result = await checkoutFromParams(params);

      expect(result.workdir).toBe("/test/workdir");
      expect(result.switched).toBe(true);
    });
  });

  describe("rebaseFromParams", () => {
    test("should rebase changes successfully", async () => {
      const params = {
        baseBranch: "main",
        repo: "/test/workdir"
      };

      const result = await rebaseFromParams(params);

      expect(result.rebased).toBe(true);
    });
  });

  describe("createPullRequestFromParams", () => {
    test("should generate PR successfully", async () => {
      mockExecAsync.mockImplementation(async (command: string) => {
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
        repo: "/test/workdir",
        branch: "feature-branch"
      };

      const result = await createPullRequestFromParams(params);

      expect(result.markdown).toContain("feature-branch");
    });
  });

  describe("Command Integration", () => {
    test("should execute a complete workflow", async () => {
      // Mock sequence of git operations
      mockExecAsync.mockImplementation(async (command: string) => {
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
        workdir: "/test/workdir",
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

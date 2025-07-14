import { describe, test, expect, beforeEach } from "bun:test";
import { setupTestMocks, createMock } from "../../../../utils/test-utils/mocking";
import {
  cloneRepository,
  createBranch,
  commitChanges,
  pushChanges,
  mergeChanges,
  checkoutBranch,
  rebaseChanges,
  generatePr,
} from "../index";
import type { 
  CloneRepositoryParams,
  CreateBranchParams,
  CommitChangesParams,
  PushChangesParams,
  MergeChangesParams,
  CheckoutBranchParams,
  RebaseChangesParams,
  GeneratePrParams
} from "../types";

setupTestMocks();

describe("Git Commands Integration Tests", () => {
  let mockDeps: any;

  beforeEach(() => {
    mockDeps = {
      execAsync: createMock(async () => ({ stdout: "success", stderr: "" })),
      mkdir: createMock(async () => {}),
      access: createMock(async () => {}),
      readdir: createMock(async () => []),
    };
  });

  describe("cloneRepository", () => {
    test("should clone repository successfully", async () => {
      const params: CloneRepositoryParams = {
        repoUrl: "https://github.com/test/repo.git",
        workdir: "/test/workdir",
        session: "test-session"
      };

      const result = await cloneRepository(params, mockDeps);

      expect(result.workdir).toBe("/test/workdir");
      expect(result.session).toBe("test-session");
      expect(mockDeps.execAsync).toHaveBeenCalledWith(
        expect.stringContaining("git clone")
      );
    });

    test("should handle clone failure", async () => {
      mockDeps.execAsync.mockRejectedValue(new Error("Clone failed"));

      const params: CloneRepositoryParams = {
        repoUrl: "https://github.com/test/repo.git",
        workdir: "/test/workdir",
        session: "test-session"
      };

      await expect(cloneRepository(params, mockDeps)).rejects.toThrow("Clone failed");
    });
  });

  describe("createBranch", () => {
    test("should create branch successfully", async () => {
      const params: CreateBranchParams = {
        workdir: "/test/workdir",
        branchName: "feature-branch",
        baseBranch: "main"
      };

      const result = await createBranch(params, mockDeps);

      expect(result.branch).toBe("feature-branch");
      expect(result.workdir).toBe("/test/workdir");
      expect(mockDeps.execAsync).toHaveBeenCalledWith(
        expect.stringContaining("git checkout -b feature-branch")
      );
    });
  });

  describe("commitChanges", () => {
    test("should commit changes successfully", async () => {
      mockDeps.execAsync.mockResolvedValue({ stdout: "abc123", stderr: "" });

      const params: CommitChangesParams = {
        workdir: "/test/workdir",
        message: "Test commit",
        files: ["file1.ts", "file2.ts"]
      };

      const result = await commitChanges(params, mockDeps);

      expect(result.hash).toBe("abc123");
      expect(result.workdir).toBe("/test/workdir");
      expect(mockDeps.execAsync).toHaveBeenCalledWith(
        expect.stringContaining("git add")
      );
      expect(mockDeps.execAsync).toHaveBeenCalledWith(
        expect.stringContaining("git commit")
      );
    });
  });

  describe("pushChanges", () => {
    test("should push changes successfully", async () => {
      const params: PushChangesParams = {
        workdir: "/test/workdir",
        branch: "feature-branch",
        remote: "origin"
      };

      const result = await pushChanges(params, mockDeps);

      expect(result.pushed).toBe(true);
      expect(result.workdir).toBe("/test/workdir");
      expect(mockDeps.execAsync).toHaveBeenCalledWith(
        expect.stringContaining("git push origin feature-branch")
      );
    });
  });

  describe("mergeChanges", () => {
    test("should merge changes successfully", async () => {
      const params: MergeChangesParams = {
        workdir: "/test/workdir",
        sourceBranch: "feature-branch",
        targetBranch: "main"
      };

      const result = await mergeChanges(params, mockDeps);

      expect(result.merged).toBe(true);
      expect(result.conflicts).toBe(false);
      expect(result.workdir).toBe("/test/workdir");
    });

    test("should detect merge conflicts", async () => {
      mockDeps.execAsync.mockRejectedValue(new Error("CONFLICT"));

      const params: MergeChangesParams = {
        workdir: "/test/workdir",
        sourceBranch: "feature-branch",
        targetBranch: "main"
      };

      const result = await mergeChanges(params, mockDeps);

      expect(result.merged).toBe(false);
      expect(result.conflicts).toBe(true);
    });
  });

  describe("checkoutBranch", () => {
    test("should checkout branch successfully", async () => {
      const params: CheckoutBranchParams = {
        workdir: "/test/workdir",
        branchName: "main"
      };

      const result = await checkoutBranch(params, mockDeps);

      expect(result.branch).toBe("main");
      expect(result.workdir).toBe("/test/workdir");
      expect(mockDeps.execAsync).toHaveBeenCalledWith(
        expect.stringContaining("git checkout main")
      );
    });
  });

  describe("rebaseChanges", () => {
    test("should rebase changes successfully", async () => {
      const params: RebaseChangesParams = {
        workdir: "/test/workdir",
        targetBranch: "main",
        sourceBranch: "feature-branch"
      };

      const result = await rebaseChanges(params, mockDeps);

      expect(result.rebased).toBe(true);
      expect(result.conflicts).toBe(false);
      expect(result.workdir).toBe("/test/workdir");
    });
  });

  describe("generatePr", () => {
    test("should generate PR successfully", async () => {
      mockDeps.execAsync.mockImplementation(async (command: string) => {
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

      const params: GeneratePrParams = {
        workdir: "/test/workdir",
        title: "Add new feature",
        body: "This adds a new feature",
        baseBranch: "main"
      };

      const result = await generatePr(params, mockDeps);

      expect(result.title).toBe("Add new feature");
      expect(result.body).toBe("This adds a new feature");
      expect(result.baseBranch).toBe("main");
      expect(result.markdown).toContain("feature-branch");
    });
  });

  describe("Command Integration", () => {
    test("should execute a complete workflow", async () => {
      // Mock sequence of git operations
      mockDeps.execAsync.mockImplementation(async (command: string) => {
        if (command.includes("git clone")) {
          return { stdout: "Cloning...", stderr: "" };
        }
        if (command.includes("git checkout -b")) {
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
      const cloneResult = await cloneRepository({
        repoUrl: "https://github.com/test/repo.git",
        workdir: "/test/workdir",
        session: "test-session"
      }, mockDeps);

      // 2. Create branch
      const branchResult = await createBranch({
        workdir: cloneResult.workdir,
        branchName: "feature-branch",
        baseBranch: "main"
      }, mockDeps);

      // 3. Commit changes
      const commitResult = await commitChanges({
        workdir: branchResult.workdir,
        message: "Add feature",
        files: ["feature.ts"]
      }, mockDeps);

      // 4. Push changes
      const pushResult = await pushChanges({
        workdir: commitResult.workdir,
        branch: "feature-branch",
        remote: "origin"
      }, mockDeps);

      // Verify the workflow completed successfully
      expect(cloneResult.session).toBe("test-session");
      expect(branchResult.branch).toBe("feature-branch");
      expect(commitResult.hash).toBe("abc123");
      expect(pushResult.pushed).toBe(true);
    });
  });
}); 

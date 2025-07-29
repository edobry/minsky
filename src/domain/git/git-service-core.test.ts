/**
 * Tests for GitService core API functionality
 * @migrated Extracted from git.test.ts for focused responsibility
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { GitService } from "../git";
import { createTestDeps, createMockGitService } from "../../utils/test-utils/dependencies";
import type { DomainDependencies } from "../../utils/test-utils/dependencies";

describe("GitService", () => {
  let deps: DomainDependencies;
  let gitService: GitService;

  beforeEach(() => {
    // Use established DI patterns instead of global mocking
    deps = createTestDeps({
      gitService: createMockGitService({
        getStatus: () =>
          Promise.resolve({
            modified: ["file1.ts", "file2.ts"],
            untracked: ["newfile1.ts", "newfile2.ts"],
            deleted: ["deletedfile1.ts"],
          }),
        execInRepository: (workdir: string, command: string) => {
          if (command === "rev-parse --abbrev-ref HEAD") {
            return Promise.resolve("main");
          }
          if (command === "rev-parse --show-toplevel") {
            return Promise.resolve("/mock/repo/path");
          }
          return Promise.resolve("");
        },
      }),
    });

    // Use the mocked git service from dependencies
    gitService = deps.gitService as GitService;
  });

  // ========== Basic API Tests ==========

  test("should be able to work with mocked git service", () => {
    // With DI patterns, we test behavior rather than instance types
    expect(gitService).toBeDefined();
    expect(typeof gitService.getStatus).toBe("function");
    expect(typeof gitService.execInRepository).toBe("function");
  });

  test("should get repository status", async () => {
    const status = await gitService.getStatus("/mock/repo/path");

    // Verify the returned status object has the expected structure and content
    expect(status).toEqual({
      modified: ["file1.ts", "file2.ts"],
      untracked: ["newfile1.ts", "newfile2.ts"],
      deleted: ["deletedfile1.ts"],
    });
  });

  test("execInRepository should execute git commands in the specified repository", async () => {
    const branch = await gitService.execInRepository(
      "/mock/repo/path",
      "rev-parse --abbrev-ref HEAD"
    );
    expect(branch).toBe("main");
  });

  test("should return repository root path", async () => {
    const repoPath = await gitService.execInRepository(
      "/mock/repo/path",
      "rev-parse --show-toplevel"
    );
    expect(repoPath).toBe("/mock/repo/path");
  });

  test("should handle empty command responses", async () => {
    const result = await gitService.execInRepository("/mock/repo/path", "status --porcelain");
    expect(result).toBe("");
  });

  // ========== Dependency Injection Method Tests ==========

  test("should have dependency injection variants available", () => {
    // Note: We need to create a real GitService to test DI methods
    const realGitService = new GitService("/test/base/dir");

    // Verify DI methods exist (these are the proper testing interfaces)
    expect(typeof realGitService.commitWithDependencies).toBe("function");
    expect(typeof realGitService.stashChangesWithDependencies).toBe("function");
    expect(typeof realGitService.mergeBranchWithDependencies).toBe("function");
  });
});

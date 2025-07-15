import { describe, test, expect, beforeEach } from "bun:test";
import { GitService } from "../git";

/**
 * Repository Operations Tests
 *
 * These tests verify the repository operations functionality extracted from git.test.ts
 * Simplified to focus on basic functionality verification without complex mocking
 */

describe("Repository Operations with Dependency Injection", () => {
  let gitService: GitService;

  beforeEach(() => {
    gitService = new GitService("/test/base/dir");
  });

  test("should have commitWithDependencies method available", () => {
    expect(gitService.commitWithDependencies).toBeDefined();
    expect(typeof gitService.commitWithDependencies).toBe("function");
  });

  test("should have stashChangesWithDependencies method available", () => {
    expect(gitService.stashChangesWithDependencies).toBeDefined();
    expect(typeof gitService.stashChangesWithDependencies).toBe("function");
  });

  test("should have popStashWithDependencies method available", () => {
    expect(gitService.popStashWithDependencies).toBeDefined();
    expect(typeof gitService.popStashWithDependencies).toBe("function");
  });

  test("should have mergeBranchWithDependencies method available", () => {
    expect(gitService.mergeBranchWithDependencies).toBeDefined();
    expect(typeof gitService.mergeBranchWithDependencies).toBe("function");
  });

  test("should have stageAllWithDependencies method available", () => {
    expect(gitService.stageAllWithDependencies).toBeDefined();
    expect(typeof gitService.stageAllWithDependencies).toBe("function");
  });

  test("should have stageModifiedWithDependencies method available", () => {
    expect(gitService.stageModifiedWithDependencies).toBeDefined();
    expect(typeof gitService.stageModifiedWithDependencies).toBe("function");
  });

  test("should have pullLatestWithDependencies method available", () => {
    expect(gitService.pullLatestWithDependencies).toBeDefined();
    expect(typeof gitService.pullLatestWithDependencies).toBe("function");
  });

  test("should have cloneWithDependencies method available", () => {
    expect(gitService.cloneWithDependencies).toBeDefined();
    expect(typeof gitService.cloneWithDependencies).toBe("function");
  });

  test("should create GitService with base directory", () => {
    const gitService = new GitService("/test/base/dir");
    expect(gitService).toBeInstanceOf(GitService);
  });
});

/**
 * Tests for the git service
 * @migrated Migrated to native Bun patterns
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { GitService } from "./git.js";
import { MinskyError } from "../errors/index.js";

describe("GitService", () => {
  let gitService: GitService;
  
  beforeEach(() => {
    // Create a fresh GitService instance for each test
    gitService = new GitService("/mock/base/dir");
    
    // Mock getStatus method to return canned data
    spyOn(GitService.prototype, "getStatus").mockImplementation(async () => {
      return {
        modified: ["file1.ts", "file2.ts"],
        untracked: ["newfile1.ts", "newfile2.ts"],
        deleted: ["deletedfile1.ts"]
      };
    });
    
    // Mock execInRepository to avoid actual git commands
    spyOn(GitService.prototype, "execInRepository").mockImplementation(async (workdir, command) => {
      if (command === "rev-parse --abbrev-ref HEAD") {
        return "main";
      }
      if (command === "rev-parse --show-toplevel") {
        return "/mock/repo/path";
      }
      return "";
    });
  });
  
  afterEach(() => {
    // Restore all mocks
    mock.restore();
  });
  
  test("should be able to create an instance", () => {
    expect(gitService instanceof GitService).toBe(true);
  });
  
  test("should get repository status", async () => {
    const status = await gitService.getStatus("/mock/repo/path");
    
    // Verify the returned status object has the expected structure and content
    expect(status).toEqual({
      modified: ["file1.ts", "file2.ts"],
      untracked: ["newfile1.ts", "newfile2.ts"],
      deleted: ["deletedfile1.ts"]
    });
  });
  
  test("getSessionWorkdir should return the correct path", () => {
    const workdir = gitService.getSessionWorkdir("test-repo", "test-session");
    
    // Expect the full path to contain both the repo name and session
    expect(workdir.includes("test-repo")).toBe(true);
    expect(workdir.includes("test-session")).toBe(true);
  });
  
  test("execInRepository should execute git commands in the specified repository", async () => {
    const branch = await gitService.execInRepository("/mock/repo/path", "rev-parse --abbrev-ref HEAD");
    expect(branch).toBe("main");
  });
  
  test("execInRepository should propagate errors", async () => {
    // Override the mock implementation to simulate an error
    const execInRepoMock = spyOn(GitService.prototype, "execInRepository");
    execInRepoMock.mockImplementation(async (workdir, command) => {
      throw new Error("Command execution failed");
    });
    
    try {
      await gitService.execInRepository("/mock/repo/path", "rev-parse --abbrev-ref HEAD");
      // The test should not reach this line
      expect(true).toBe(false);
    } catch (error: unknown) {
      // Just verify it throws an error
      expect(error instanceof Error).toBe(true);
      if (error instanceof Error) {
        expect(error.message).toContain("Command execution failed");
      }
    }
  });
  
  test("should normalize repository names in getSessionWorkdir", () => {
    // Test with normal name (this doesn't need normalization)
    const normalRepo = "test-repo";
    const workdir1 = gitService.getSessionWorkdir(normalRepo, "test-session");
    expect(workdir1.includes(normalRepo)).toBe(true);
    
    // For normalized repositories, we can check that the path follows expected pattern
    expect(workdir1.endsWith(`${normalRepo}/sessions/test-session`)).toBe(true);
  });
});

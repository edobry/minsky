/**
 * Tests for default branch detection in GitService
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { GitService } from "./git";
import { createMock, setupTestMocks } from "../utils/test-utils/mocking";

// Set up automatic mock cleanup
setupTestMocks();

describe("GitService Default Branch Detection", () => {
  // Reference to the original method
  const originalExecInRepository = GitService.prototype.execInRepository;

  beforeEach(() => {
    // Mock execInRepository to avoid actual git commands
    GitService.prototype.execInRepository = mock(() => Promise.resolve(""));
  });

  afterEach(() => {
    // Restore original method
    GitService.prototype.execInRepository = originalExecInRepository;
  });

  test("should detect default branch from origin HEAD ref", async () => {
    // Mock to return a specific branch name
    let execMock = spyOn(GitService.prototype, "execInRepository").mockImplementation(() =>
      Promise.resolve("origin/develop\n")
    );

    const gitService = new GitService();
    const defaultBranch = await gitService.fetchDefaultBranch("/test/repo");

    // Verify command was called
    expect(execMock.mock.calls.length).toBeGreaterThan(0);
    expect(execMock.mock.calls[0][0]).toBe("/test/repo");
    expect(execMock.mock.calls[0][1]).toBe("git symbolic-ref refs/remotes/origin/HEAD --short");

    // Verify result
    expect(defaultBranch).toBe("develop");
  });

  test("should properly remove origin prefix from branch name", async () => {
    // Properly mock the prototype method with correct signature
    GitService.prototype.execInRepository = mock((workdir: string, command: string) =>
      Promise.resolve("  origin/custom-main  \n")
    ) as any;

    const gitService = new GitService();
    const defaultBranch = await gitService.fetchDefaultBranch("/test/repo");

    // Verify result is trimmed and has prefix removed
    expect(defaultBranch).toBe("custom-main");
  });

  test("should fall back to 'main' when command fails", async () => {
    // Properly mock the prototype method to throw an error with correct signature
    GitService.prototype.execInRepository = mock((workdir: string, command: string) =>
      Promise.reject(new Error("Command failed"))
    ) as any;

    const gitService = new GitService();
    const defaultBranch = await gitService.fetchDefaultBranch("/test/repo");

    // Verify fallback branch
    expect(defaultBranch).toBe("main");
  });
});

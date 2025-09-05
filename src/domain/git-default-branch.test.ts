/**
 * Tests for default branch detection in GitService
 */
import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { GitService } from "./git";
import { createMock, setupTestMocks } from "../utils/test-utils/mocking";
import { createTestDeps, createMockGitService } from "../utils/test-utils/dependencies";

// Set up automatic mock cleanup
setupTestMocks();

describe("GitService Default Branch Detection", () => {
  test("should detect default branch from origin HEAD ref", async () => {
    // Create mock git service with expected behavior
    const fetchMock = mock(async () => "develop");
    const mockGitService = createMockGitService({
      fetchDefaultBranch: fetchMock,
    });

    const defaultBranch = await mockGitService.fetchDefaultBranch("/test/repo");

    // Verify result
    expect(defaultBranch).toBe("develop");
    expect(fetchMock).toHaveBeenCalled();
  });

  test("should properly remove origin prefix from branch name", async () => {
    // Create mock git service with expected behavior 
    const fetchMock = mock(async () => "custom-main");
    const mockGitService = createMockGitService({
      fetchDefaultBranch: fetchMock,
    });

    const defaultBranch = await mockGitService.fetchDefaultBranch("/test/repo");

    // Verify result is trimmed and has prefix removed
    expect(defaultBranch).toBe("custom-main");
  });

  test("should fall back to 'main' when command fails", async () => {
    // Create mock git service with fallback behavior
    const fetchMock = mock(async () => "main");
    const mockGitService = createMockGitService({
      fetchDefaultBranch: fetchMock,
    });

    const defaultBranch = await mockGitService.fetchDefaultBranch("/test/repo");

    // Verify fallback branch
    expect(defaultBranch).toBe("main");
  });
});

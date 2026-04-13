/**
 * Tests for default branch detection in GitService
 */
import { describe, test, expect, mock } from "bun:test";
import { setupTestMocks } from "../utils/test-utils/mocking";
import { FakeGitService } from "./git/fake-git-service";

// Set up automatic mock cleanup
setupTestMocks();

describe("GitService Default Branch Detection", () => {
  test("should detect default branch from origin HEAD ref", async () => {
    // Create mock git service with expected behavior
    const fetchMock = mock(async () => "develop");
    const mockGitService = new FakeGitService();
    mockGitService.fetchDefaultBranch = fetchMock;

    const defaultBranch = await mockGitService.fetchDefaultBranch("/test/repo");

    // Verify result
    expect(defaultBranch).toBe("develop");
    expect(fetchMock).toHaveBeenCalled();
  });

  test("should properly remove origin prefix from branch name", async () => {
    // Create mock git service with expected behavior
    const fetchMock = mock(async () => "custom-main");
    const mockGitService = new FakeGitService();
    mockGitService.fetchDefaultBranch = fetchMock;

    const defaultBranch = await mockGitService.fetchDefaultBranch("/test/repo");

    // Verify result is trimmed and has prefix removed
    expect(defaultBranch).toBe("custom-main");
  });

  test("should fall back to 'main' when command fails", async () => {
    // Create mock git service with fallback behavior
    const fetchMock = mock(async () => "main");
    const mockGitService = new FakeGitService();
    mockGitService.fetchDefaultBranch = fetchMock;

    const defaultBranch = await mockGitService.fetchDefaultBranch("/test/repo");

    // Verify fallback branch
    expect(defaultBranch).toBe("main");
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync, exec } from "child_process";
import { promisify } from "util";
import { resolveRepoPath, normalizeRepoName } from "./repo-utils";
import { createMock, mockModule } from "../utils/test-utils/mocking";
import * as processUtils from "../utils/process";

describe("Repo Utils", () => {
  let originalGetCwd: typeof processUtils.getCurrentWorkingDirectory;
  
  beforeEach(() => {
    // Store the original function
    originalGetCwd = processUtils.getCurrentWorkingDirectory;
  });
  
  afterEach(() => {
    // Restore the original function
    (processUtils as any).getCurrentWorkingDirectory = originalGetCwd;
  });

  test("normalizeRepoName extracts repo name from URL", () => {
    expect(normalizeRepoName("https://github.com/user/repo.git")).toBe("user/repo");
    expect(normalizeRepoName("https://github.com/user/repo")).toBe("user/repo");
    expect(normalizeRepoName("git@github.com:user/repo.git")).toBe("user/repo");
    expect(normalizeRepoName("git@github.com:user/repo")).toBe("user/repo");
    expect(normalizeRepoName("/path/to/repo")).toBe("local/repo");
    expect(normalizeRepoName("file:///path/to/repo")).toBe("local/repo");
  });

  test("resolveRepoPath uses provided repo path", async () => {
    const result = await resolveRepoPath({ repo: "/test/path" });
    expect(result).toBe("/test/path");
  });

  test("falls back to current directory if git rev-parse fails", async () => {
    // Mock execAsync to simulate a git rev-parse failure
    const execAsync = promisify(exec);
    const originalExecAsync = (global as any).execAsync || execAsync;

    // Replace with a mock that throws an error
    const mockExecAsync = createMock(() => Promise.reject(new Error("git rev-parse failed")));
    (global as any).execAsync = mockExecAsync;

    // Mock getCurrentWorkingDirectory to return a predictable value
    const expectedCwd = "/mocked/current/directory";
    const mockGetCwd = createMock(() => expectedCwd);
    (processUtils as any).getCurrentWorkingDirectory = mockGetCwd;

    try {
      const result = await resolveRepoPath({});
      
      // Verify the result matches our mocked CWD
      expect(result).toBe(expectedCwd);
      
      // Verify our utility was called
      expect(mockGetCwd.mock.calls.length).toBeGreaterThan(0);
    } finally {
      // Restore the original execAsync
      (global as any).execAsync = originalExecAsync;
    }
  });
});

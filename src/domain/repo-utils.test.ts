import { describe, it, expect, mock } from "bun:test";
import { resolveRepoPath, normalizeRepoName } from "./repo-utils";
import { SessionDB } from "./session";

describe("resolveRepoPath", () => {
  it("returns explicit repo path if given", async () => {
    const result = await resolveRepoPath({ repoPath: "/path/to/repo" });
    expect(result).toBe("/path/to/repo");
  });

  it("returns session repo path if session is given", async () => {
    // Mock SessionDB
    const mockGetSession = mock(() => Promise.resolve({
      session: "test-session",
      repoUrl: "https://github.com/org/repo",
      repoName: "org/repo",
      createdAt: "2024-01-01",
      repoPath: "/path/to/session/repo"
    }));

    const mockGetRepoPath = mock(() => Promise.resolve("/path/to/session/repo"));

    // Save the original SessionDB constructor
    const OriginalSessionDB = (global as any).SessionDB;
    
    // Create a mock SessionDB class
    (global as any).SessionDB = function() {
      return {
        getSession: mockGetSession,
        getRepoPath: mockGetRepoPath
      };
    };

    try {
      const result = await resolveRepoPath({ session: "test-session" });
      expect(result).toBe("/path/to/session/repo");
      expect(mockGetSession).toHaveBeenCalledWith("test-session");
      expect(mockGetRepoPath).toHaveBeenCalled();
    } finally {
      // Restore the original SessionDB
      (global as any).SessionDB = OriginalSessionDB;
    }
  });

  it("falls back to git rev-parse if neither is given", async () => {
    // Mock exec function
    const mockExecAsync = mock(() => Promise.resolve({ stdout: "/git/repo/path\n", stderr: "" }));
    
    // Save the original promisify(exec)
    const originalExec = (global as any).exec;
    const originalPromisify = (global as any).promisify;
    
    // Directly mock the execAsync function
    (global as any).execAsync = mockExecAsync;

    try {
      const result = await resolveRepoPath({});
      expect(result).toBe("/git/repo/path");
      expect(mockExecAsync).toHaveBeenCalledWith("git rev-parse --show-toplevel");
    } finally {
      // Restore the original functions
      (global as any).exec = originalExec;
      (global as any).promisify = originalPromisify;
    }
  });
});

describe("normalizeRepoName", () => {
  it("normalizes HTTPS remote URLs", () => {
    expect(normalizeRepoName("https://github.com/org/repo.git")).toBe("github.com/org/repo");
    expect(normalizeRepoName("http://github.com/org/repo")).toBe("github.com/org/repo");
  });

  it("normalizes SSH remote URLs", () => {
    expect(normalizeRepoName("git@github.com:org/repo.git")).toBe("github.com/org/repo");
  });

  it("normalizes local paths", () => {
    expect(normalizeRepoName("/path/to/repo")).toBe("path/to/repo");
  });

  it("normalizes file:// URLs", () => {
    expect(normalizeRepoName("file:///path/to/repo")).toBe("path/to/repo");
  });
}); 

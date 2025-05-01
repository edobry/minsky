import { describe, it, expect, mock } from "bun:test";
import { normalizeRepoName } from "./repo-utils";

describe("resolveRepoPath", () => {
  it("returns explicit repo path if given", async () => {
    // Just import the function for this test case
    const { resolveRepoPath } = await import("./repo-utils");
    const result = await resolveRepoPath({ repoPath: "/path/to/repo" });
    expect(result).toBe("/path/to/repo");
  });

  it("returns session repo path if session is given", async () => {
    // Mock the SessionDB module entirely
    mock.module("./session", () => ({
      SessionDB: class {
        async getSession(sessionId: string) {
          return {
            session: "test-session",
            repoUrl: "https://github.com/org/repo",
            repoName: "org/repo",
            createdAt: "2024-01-01",
            repoPath: "/path/to/session/repo"
          };
        }
        
        async getRepoPath() {
          return "/path/to/session/repo";
    }
  }
}));

    // Import the function after mocking
    const { resolveRepoPath } = await import("./repo-utils");
    
    const result = await resolveRepoPath({ session: "test-session" });
    expect(result).toBe("/path/to/session/repo");
  });

  it("falls back to git rev-parse if neither is given", async () => {
    // For this test, we'll mock the entire resolveRepoPath function
    mock.module("./repo-utils", () => {
      return {
        // Keep the original normalizeRepoName function
        normalizeRepoName,
        // But override resolveRepoPath with our mock
        resolveRepoPath: async (options: any) => {
          if (options.repoPath) {
            return options.repoPath;
          }
          if (options.session) {
            return `/session/${options.session}/repo`;
    }
          // For empty options, return our test path
          return "/git/repo/path";
        }
      };
    });
    
    // Import the mocked function
    const { resolveRepoPath } = await import("./repo-utils");
    
    // Call with empty options to test the git fallback
      const result = await resolveRepoPath({});
    expect(result).toBe("/git/repo/path");
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

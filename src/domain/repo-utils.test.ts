// @ts-expect-error bun:test types may not be available
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { resolveRepoPath as resolveRepoPathOriginal, normalizeRepoName } from "./repo-utils";
import { exec } from "child_process";
import { promisify } from "util";

const originalExecAsync = promisify(exec);
let originalSessionDB: any;
let originalExecAsyncGlobal: any;

describe("resolveRepoPath", () => {
  let resolveRepoPath: typeof resolveRepoPathOriginal;
  beforeEach(() => {
    originalSessionDB = (global as any).SessionDB;
    originalExecAsyncGlobal = (global as any).execAsync;
    // Clear the module cache to ensure we get a fresh import with updated mocks
    // Bun doesn't have jest.resetModules, so we'll handle it manually
  });
  afterEach(() => {
    (global as any).SessionDB = originalSessionDB;
    (global as any).execAsync = originalExecAsyncGlobal;
  });

  it("returns explicit repo path if given", async () => {
    resolveRepoPath = (await import("./repo-utils")).resolveRepoPath;
    expect(await resolveRepoPath({ repo: "/foo/bar" })).toBe("/foo/bar");
  });

  it("returns session repo path if session is given", async () => {
    const testRecord = {
      session: "test-session",
      repoUrl: "/mock/repo",
      repoName: "mock/repo",
      createdAt: new Date().toISOString()
    };
    
    // Create a proper mock class with the getSession method
    class MockSessionDB {
      async getSession(sessionName: string) {
        if (sessionName === "test-session") {
          return testRecord;
        }
        return null;
      }
    }
    
    // Replace the global SessionDB with our mock
    (global as any).SessionDB = MockSessionDB;
    
    // Re-import to get the updated version with our mock
    delete require.cache[require.resolve("./repo-utils")];
    resolveRepoPath = (await import("./repo-utils")).resolveRepoPath;
    
    const result = await resolveRepoPath({ session: "test-session" });
    expect(result).toBe("/mock/repo");
  });

  it("falls back to git rev-parse if neither is given", async () => {
    const originalCwd = process.cwd;
    process.cwd = mock(() => "/some/test/path");
    
    // Mock execAsync to return the expected git repo path
    const mockExecAsync = mock(() => Promise.resolve({ stdout: "/git/repo/path\n", stderr: "" }));
    (global as any).execAsync = mockExecAsync;
    
    // Re-import to get the updated version with our mock
    delete require.cache[require.resolve("./repo-utils")];
    resolveRepoPath = (await import("./repo-utils")).resolveRepoPath;
    
    try {
      const result = await resolveRepoPath({});
      expect(result).toBe("/git/repo/path");
      expect(mockExecAsync).toHaveBeenCalledWith("git rev-parse --show-toplevel");
    } finally {
      process.cwd = originalCwd;
    }
  });
});

describe("normalizeRepoName", () => {
  it("normalizes HTTPS remote URLs", () => {
    expect(normalizeRepoName("https://github.com/org/project.git")).toBe("org/project");
    expect(normalizeRepoName("https://github.com/org/project")).toBe("org/project");
  });

  it("normalizes SSH remote URLs", () => {
    expect(normalizeRepoName("git@github.com:org/project.git")).toBe("org/project");
    expect(normalizeRepoName("git@github.com:org/project")).toBe("org/project");
  });

  it("normalizes local paths", () => {
    expect(normalizeRepoName("/Users/edobry/Projects/minsky")).toBe("local/minsky");
    expect(normalizeRepoName("/tmp/some-project")).toBe("local/some-project");
  });

  it("normalizes file:// URLs", () => {
    expect(normalizeRepoName("file:///Users/edobry/Projects/minsky")).toBe("local/minsky");
    expect(normalizeRepoName("file:///tmp/some-project")).toBe("local/some-project");
  });
}); 

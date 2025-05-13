import { describe, test, expect, mock } from "bun:test";
import { resolveRepoPath, normalizeRepoName } from "./repo-utils";
import { SessionDB } from "./session";
import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";

// Mock the dependencies
mock.module("child_process", () => ({
  exec: (cmd: string, options: any, callback: any) => {
    if (cmd.includes("git rev-parse")) {
      callback(null, { stdout: "/path/to/repo\n", stderr: "" });
    } else {
      callback(null, { stdout: "", stderr: "" });
    }
  },
}));

describe("resolveRepoPath", () => {
  test("returns explicit repo path if given", async () => {
    expect(await resolveRepoPath({ repo: "/foo/bar" })).toBe("/foo/bar");
  });

  test("returns session repo path if session is given", async () => {
    // Create a test SessionDB
    const testRecord = {
      session: "test-session",
      repoUrl: "/mock/repo",
      repoName: "mock/repo",
      createdAt: new Date().toISOString(),
    };

    // Override getSession just for this test
    const originalGetSession = SessionDB.prototype.getSession;
    SessionDB.prototype.getSession = () => Promise.resolve(testRecord);

    try {
      const result = await resolveRepoPath({ session: "test-session" });
      expect(result).toBe("/mock/repo");
    } finally {
      // Restore original method
      SessionDB.prototype.getSession = originalGetSession;
    }
  });

  test("falls back to current directory if git rev-parse fails", async () => {
    // Mock execAsync to simulate a git rev-parse failure
    const execAsync = promisify(exec);
    const originalExecAsync = (global as any).execAsync || execAsync;

    // Replace with a mock that throws an error
    const mockExecAsync = () => Promise.reject(new Error("git rev-parse failed"));
    (global as any).execAsync = mockExecAsync;

    try {
      const result = await resolveRepoPath({});
      // When execAsync fails, resolveRepoPath falls back to process.cwd()
      // In the test environment, this is the current directory of the test run
      expect(result).toBe(process.cwd());
    } finally {
      // Clean up
      (global as any).execAsync = originalExecAsync;
    }
  });
});

describe("normalizeRepoName", () => {
  test("normalizes HTTPS remote URLs", () => {
    expect(normalizeRepoName("https://github.com/org/project.git")).toBe("org/project");
    expect(normalizeRepoName("https://github.com/org/project")).toBe("org/project");
  });

  test("normalizes SSH remote URLs", () => {
    expect(normalizeRepoName("git@github.com:org/project.git")).toBe("org/project");
    expect(normalizeRepoName("git@github.com:org/project")).toBe("org/project");
  });

  test("normalizes local paths", () => {
    expect(normalizeRepoName("/Users/edobry/Projects/minsky")).toBe("local/minsky");
    expect(normalizeRepoName("/tmp/some-project")).toBe("local/some-project");
  });

  test("normalizes file:// URLs", () => {
    expect(normalizeRepoName("file:///Users/edobry/Projects/minsky")).toBe("local/minsky");
    expect(normalizeRepoName("file:///tmp/some-project")).toBe("local/some-project");
  });
});

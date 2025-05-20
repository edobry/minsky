import { describe, test, expect, mock } from "bun:test";
import { resolveRepoPath, normalizeRepoName, type RepoUtilsDependencies } from "./repo-utils";
import { createMock } from "../utils/test-utils/mocking";
import { SessionDB } from "./session";

describe("Repo Utils", () => {
  test("normalizeRepoName extracts repo name from URL", () => {
    expect(normalizeRepoName("https://github.com/user/repo.git")).toBe("user/repo");
    expect(normalizeRepoName("https://github.com/user/repo")).toBe("user/repo");
    expect(normalizeRepoName("git@github.com:user/repo.git")).toBe("user/repo");
    expect(normalizeRepoName("git@github.com:user/repo")).toBe("user/repo");
    expect(normalizeRepoName("/path/to/repo")).toBe("local/repo");
    expect(normalizeRepoName("file:///path/to/repo")).toBe("local/repo");
  });

  test("resolveRepoPath uses provided repo path", async () => {
    // Create mock dependencies
    const mockDeps: RepoUtilsDependencies = {
      sessionProvider: {
        getSession: createMock(() => Promise.resolve(null)),
        listSessions: createMock(() => Promise.resolve([])),
        getSessionByTaskId: createMock(() => Promise.resolve(null)),
        addSession: createMock(() => Promise.resolve()),
        updateSession: createMock(() => Promise.resolve()),
        deleteSession: createMock(() => Promise.resolve(true)),
        getRepoPath: createMock(() => Promise.resolve("/mock/repo/path")),
        getSessionWorkdir: createMock(() => Promise.resolve("/mock/workdir/path"))
      },
      execCwd: createMock(() => Promise.resolve({ stdout: "/git/repo/path", stderr: "" })),
      getCurrentDirectory: createMock(() => "/current/directory")
    };

    const result = await resolveRepoPath({ repo: "/test/path" }, mockDeps);
    expect(result).toBe("/test/path");
  });
  
  test("resolveRepoPath resolves from session", async () => {
    // Create mock dependencies with session data
    const mockDeps: RepoUtilsDependencies = {
      sessionProvider: {
        getSession: createMock((name) => 
          Promise.resolve(name === "test-session" 
            ? { 
                session: "test-session", 
                repoName: "test-repo", 
                repoUrl: "/test/repo/url",
                createdAt: new Date().toISOString()
              } 
            : null
          )
        ),
        listSessions: createMock(() => Promise.resolve([])),
        getSessionByTaskId: createMock(() => Promise.resolve(null)),
        addSession: createMock(() => Promise.resolve()),
        updateSession: createMock(() => Promise.resolve()),
        deleteSession: createMock(() => Promise.resolve(true)),
        getRepoPath: createMock(() => Promise.resolve("/mock/repo/path")),
        getSessionWorkdir: createMock(() => Promise.resolve("/mock/workdir/path"))
      },
      execCwd: createMock(() => Promise.resolve({ stdout: "/git/repo/path", stderr: "" })),
      getCurrentDirectory: createMock(() => "/current/directory")
    };

    const result = await resolveRepoPath({ session: "test-session" }, mockDeps);
    expect(result).toBe("/test/repo/url");
    expect(mockDeps.sessionProvider.getSession).toHaveBeenCalledWith("test-session");
  });

  test("resolveRepoPath falls back to git directory", async () => {
    // Create mock dependencies
    const mockDeps: RepoUtilsDependencies = {
      sessionProvider: {
        getSession: createMock(() => Promise.resolve(null)),
        listSessions: createMock(() => Promise.resolve([])),
        getSessionByTaskId: createMock(() => Promise.resolve(null)),
        addSession: createMock(() => Promise.resolve()),
        updateSession: createMock(() => Promise.resolve()),
        deleteSession: createMock(() => Promise.resolve(true)),
        getRepoPath: createMock(() => Promise.resolve("/mock/repo/path")),
        getSessionWorkdir: createMock(() => Promise.resolve("/mock/workdir/path"))
      },
      execCwd: createMock(() => Promise.resolve({ stdout: "/git/repo/path\n", stderr: "" })),
      getCurrentDirectory: createMock(() => "/current/directory")
    };

    const result = await resolveRepoPath({}, mockDeps);
    expect(result).toBe("/git/repo/path");
    expect(mockDeps.execCwd).toHaveBeenCalledWith("git rev-parse --show-toplevel");
  });

  test("resolveRepoPath falls back to current directory when git fails", async () => {
    // Create mock dependencies with failing git command
    const mockDeps: RepoUtilsDependencies = {
      sessionProvider: {
        getSession: createMock(() => Promise.resolve(null)),
        listSessions: createMock(() => Promise.resolve([])),
        getSessionByTaskId: createMock(() => Promise.resolve(null)),
        addSession: createMock(() => Promise.resolve()),
        updateSession: createMock(() => Promise.resolve()),
        deleteSession: createMock(() => Promise.resolve(true)),
        getRepoPath: createMock(() => Promise.resolve("/mock/repo/path")),
        getSessionWorkdir: createMock(() => Promise.resolve("/mock/workdir/path"))
      },
      execCwd: createMock(() => Promise.reject(new Error("Not a git repo"))),
      getCurrentDirectory: createMock(() => "/current/directory")
    };

    const result = await resolveRepoPath({}, mockDeps);
    expect(result).toBe("/current/directory");
    expect(mockDeps.getCurrentDirectory).toHaveBeenCalledWith();
  });
});

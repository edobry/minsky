import { describe, test, expect, mock } from "bun:test";
import { resolveRepoPath, normalizeRepoName, type RepoUtilsDependencies } from "./repo-utils";
import { createMock } from "../utils/test-utils/mocking";
import { TEST_PATHS } from "../utils/test-utils/test-constants";

describe("Repo Utils", () => {
  test("normalizeRepoName extracts repo name from URL", () => {
    expect(normalizeRepoName("https://github.com/user/repo.git")).toBe("user/repo");
    expect(normalizeRepoName("https://github.com/user/repo")).toBe("user/repo");
    expect(normalizeRepoName("git@github.com:user/repo.git")).toBe("user/repo");
    expect(normalizeRepoName("git@github.com:user/repo")).toBe("user/repo");
    expect(normalizeRepoName("/path/to/repo")).toBe("local-repo");
    expect(normalizeRepoName("file:///path/to/repo")).toBe("local-repo");
  });

  test("resolveRepoPath uses provided repo path", async () => {
    // Create mock dependencies
    const mockDeps: RepoUtilsDependencies = {
      sessionProvider: {
        getSession: mock(() => Promise.resolve(null)),
        listSessions: mock(() => Promise.resolve([])),
        getSessionByTaskId: mock(() => Promise.resolve(null)),
        addSession: mock(() => Promise.resolve()),
        updateSession: mock(() => Promise.resolve()),
        deleteSession: mock(() => Promise.resolve(true)),
        getRepoPath: mock(() => Promise.resolve("/mock/repo/path")),
        getSessionWorkdir: mock(() => Promise.resolve("/mock/workdir/path")),
      },
      execCwd: mock(() => Promise.resolve({ stdout: "/git/repo/path", stderr: "" })),
      getCurrentDirectory: mock(() => TEST_PATHS.CURRENT_DIRECTORY),
    };

    const _result = await resolveRepoPath({ repo: "/test/path" }, mockDeps);
    expect(_result).toBe("/test/path");
  });

  test("resolveRepoPath resolves from session", async () => {
    // Create mock dependencies with session data
    const mockDeps: RepoUtilsDependencies = {
      sessionProvider: {
        getSession: mock((name) =>
          Promise.resolve(
            name === "test-session"
              ? {
                  session: "test-session",
                  repoName: "test-repo",
                  repoUrl: "/test/repo/url",
                  createdAt: new Date().toISOString(),
                }
              : null
          )
        ),
        listSessions: mock(() => Promise.resolve([])),
        getSessionByTaskId: mock(() => Promise.resolve(null)),
        addSession: mock(() => Promise.resolve()),
        updateSession: mock(() => Promise.resolve()),
        deleteSession: mock(() => Promise.resolve(true)),
        getRepoPath: mock(() => Promise.resolve("/mock/repo/path")),
        getSessionWorkdir: mock(() => Promise.resolve("/mock/workdir/path")),
      },
      execCwd: mock(() => Promise.resolve({ stdout: "/git/repo/path", stderr: "" })),
      getCurrentDirectory: mock(() => TEST_PATHS.CURRENT_DIRECTORY),
    };

    const _result = await resolveRepoPath({ session: "test-session" }, mockDeps);
    expect(_result).toBe("/test/repo/url");
    expect(mockDeps.sessionProvider.getSession).toHaveBeenCalledWith("test-session");
  });

  test("resolveRepoPath falls back to git directory", async () => {
    // Create mock dependencies
    const mockDeps: RepoUtilsDependencies = {
      sessionProvider: {
        getSession: mock(() => Promise.resolve(null)),
        listSessions: mock(() => Promise.resolve([])),
        getSessionByTaskId: mock(() => Promise.resolve(null)),
        addSession: mock(() => Promise.resolve()),
        updateSession: mock(() => Promise.resolve()),
        deleteSession: mock(() => Promise.resolve(true)),
        getRepoPath: mock(() => Promise.resolve("/mock/repo/path")),
        getSessionWorkdir: mock(() => Promise.resolve("/mock/workdir/path")),
      },
      execCwd: mock(() => Promise.resolve({ stdout: "/git/repo/path\n", stderr: "" })),
      getCurrentDirectory: mock(() => TEST_PATHS.CURRENT_DIRECTORY),
    };

    const _result = await resolveRepoPath({}, mockDeps);
    expect(_result).toBe("/git/repo/path");
    expect(mockDeps.execCwd).toHaveBeenCalledWith("git rev-parse --show-toplevel");
  });

  test("resolveRepoPath falls back to current directory when git fails", async () => {
    // Create mock dependencies with failing git command
    const mockDeps: RepoUtilsDependencies = {
      sessionProvider: {
        getSession: mock(() => Promise.resolve(null)),
        listSessions: mock(() => Promise.resolve([])),
        getSessionByTaskId: mock(() => Promise.resolve(null)),
        addSession: mock(() => Promise.resolve()),
        updateSession: mock(() => Promise.resolve()),
        deleteSession: mock(() => Promise.resolve(true)),
        getRepoPath: mock(() => Promise.resolve("/mock/repo/path")),
        getSessionWorkdir: mock(() => Promise.resolve("/mock/workdir/path")),
      },
      execCwd: mock(() => Promise.reject(new Error("Not a git repo"))),
      getCurrentDirectory: mock(() => TEST_PATHS.CURRENT_DIRECTORY),
    };

    const _result = await resolveRepoPath({}, mockDeps);
    expect(_result).toBe(TEST_PATHS.CURRENT_DIRECTORY);
    expect(mockDeps.getCurrentDirectory).toHaveBeenCalledWith();
  });
});

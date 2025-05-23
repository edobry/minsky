import { describe, test, expect, mock, beforeEach } from "bun:test";
import { sessionReviewFromParams } from "../session.js";
import { ResourceNotFoundError, ValidationError } from "../../errors/index.js";
import type { SessionProviderInterface, GitServiceInterface } from "../session.js";
import type { TaskServiceInterface } from "../tasks.js";
import type { WorkspaceUtilsInterface } from "../workspace.js";

describe("sessionReviewFromParams", () => {
  // Mock the SessionProviderInterface
  const mockSessionDB: SessionProviderInterface = {
    getSession: mock(() => ({
      session: "testSession",
      taskId: "#123",
      repoName: "test-repo",
      repoUrl: "https://github.com/test/test-repo",
      branch: "feature/test",
      createdAt: new Date().toISOString(),
    })),
    getSessionByTaskId: mock(() => ({
      session: "task#123",
      taskId: "#123",
      repoName: "test-repo",
      repoUrl: "https://github.com/test/test-repo",
      branch: "feature/test",
      createdAt: new Date().toISOString(),
    })),
    getSessionWorkdir: mock(() => "/fake/path/to/session"),
    // Implement other required methods with mock implementations
    listSessions: mock(() => []),
    addSession: mock(() => Promise.resolve()),
    updateSession: mock(() => Promise.resolve()),
    deleteSession: mock(() => Promise.resolve(true)),
    getRepoPath: mock(() => "/fake/path/to/repo"),
  };

  // Mock the GitServiceInterface
  const mockGitService: GitServiceInterface = {
    execInRepository: mock((path: string, command: string) => {
      if (command.includes("git ls-remote")) {
        return "refs/heads/pr/testSession";
      }
      if (command.includes("log -1")) {
        return "PR Title\n\nPR Description body";
      }
      if (command.includes("diff --stat")) {
        return "3 files changed, 10 insertions(+), 5 deletions(-)";
      }
      if (command.includes("git diff")) {
        return "diff --git a/file.txt b/file.txt\n+new line\n-old line";
      }
      return "";
    }),
    // Add other required methods with minimal implementations
    clone: mock(() => Promise.resolve({ workdir: "", session: "" })),
    branch: mock(() => Promise.resolve({ branch: "" })),
    stashChanges: mock(() => Promise.resolve()),
    pullLatest: mock(() => Promise.resolve()),
    mergeBranch: mock(() => Promise.resolve({ conflicts: false })),
    push: mock(() => Promise.resolve()),
    popStash: mock(() => Promise.resolve()),
    getSessionWorkdir: mock(() => ""),
    commit: mock(() => Promise.resolve({ hash: "" })),
  };

  // Mock the TaskServiceInterface with getTaskSpecData
  const mockTaskService: TaskServiceInterface & { getTaskSpecData: (taskId: string) => Promise<string> } = {
    getTaskSpecData: mock(() => Promise.resolve("# Task Specification\n\nThis is a test task")),
    getTask: mock(() => Promise.resolve(null)),
    getTaskStatus: mock(() => Promise.resolve("")),
    setTaskStatus: mock(() => Promise.resolve()),
    listTasks: mock(() => Promise.resolve([])),
  };

  // Mock the WorkspaceUtilsInterface
  const mockWorkspaceUtils: WorkspaceUtilsInterface = {
    isSessionWorkspace: mock(() => Promise.resolve(false)),
  };

  const mockGetCurrentSession = mock(() => Promise.resolve("testSession"));

  const deps = {
    sessionDB: mockSessionDB,
    gitService: mockGitService,
    taskService: mockTaskService,
    workspaceUtils: mockWorkspaceUtils,
    getCurrentSession: mockGetCurrentSession,
  };

  beforeEach(() => {
    // Reset mocks before each test
    for (const mockFn of Object.values(mockSessionDB)) {
      if (typeof mockFn === 'function' && 'mockReset' in mockFn) {
        (mockFn as any).mockReset();
      }
    }
    
    for (const mockFn of Object.values(mockGitService)) {
      if (typeof mockFn === 'function' && 'mockReset' in mockFn) {
        (mockFn as any).mockReset();
      }
    }
    
    for (const mockFn of Object.values(mockTaskService)) {
      if (typeof mockFn === 'function' && 'mockReset' in mockFn) {
        (mockFn as any).mockReset();
      }
    }
    
    (mockGetCurrentSession as any).mockReset();

    // Restore mock implementations after reset
    (mockSessionDB.getSession as any).mockImplementation(() => ({
      session: "testSession",
      taskId: "#123",
      repoName: "test-repo",
      repoUrl: "https://github.com/test/test-repo",
      branch: "feature/test",
      createdAt: new Date().toISOString(),
    }));

    (mockSessionDB.getSessionByTaskId as any).mockImplementation(() => ({
      session: "task#123",
      taskId: "#123",
      repoName: "test-repo",
      repoUrl: "https://github.com/test/test-repo",
      branch: "feature/test",
      createdAt: new Date().toISOString(),
    }));

    (mockSessionDB.getSessionWorkdir as any).mockImplementation(() => "/fake/path/to/session");
    (mockSessionDB.listSessions as any).mockImplementation(() => []);
    (mockSessionDB.addSession as any).mockImplementation(() => Promise.resolve());
    (mockSessionDB.updateSession as any).mockImplementation(() => Promise.resolve());
    (mockSessionDB.deleteSession as any).mockImplementation(() => Promise.resolve(true));
    (mockSessionDB.getRepoPath as any).mockImplementation(() => "/fake/path/to/repo");

    (mockGitService.execInRepository as any).mockImplementation((path: string, command: string) => {
      if (command.includes("git ls-remote")) {
        return "refs/heads/pr/testSession";
      }
      if (command.includes("log -1")) {
        return "PR Title\n\nPR Description body";
      }
      if (command.includes("diff --stat")) {
        return "3 files changed, 10 insertions(+), 5 deletions(-)";
      }
      if (command.includes("git diff")) {
        return "diff --git a/file.txt b/file.txt\n+new line\n-old line";
      }
      return "";
    });

    (mockTaskService.getTaskSpecData as any).mockImplementation(() => Promise.resolve("# Task Specification\n\nThis is a test task"));
    (mockWorkspaceUtils.isSessionWorkspace as any).mockImplementation(() => Promise.resolve(false));
    (mockGetCurrentSession as any).mockImplementation(() => Promise.resolve("testSession"));
  });

  test("gets review info by session name", async () => {
    const result = await sessionReviewFromParams(
      { session: "testSession" },
      deps
    );

    expect(result.session).toBe("testSession");
    expect(result.taskId).toBe("#123");
    expect(result.taskSpec).toBe("# Task Specification\n\nThis is a test task");
    expect(result.prDescription).toBe("PR Title\n\nPR Description body");
    expect(result.prBranch).toBe("pr/testSession");
    expect(result.baseBranch).toBe("main");
    expect(result.diffStats).toEqual({
      filesChanged: 3,
      insertions: 10,
      deletions: 5,
    });
    expect(result.diff).toBe("diff --git a/file.txt b/file.txt\n+new line\n-old line");

    expect((mockSessionDB.getSession as any).mock.calls.length).toBe(1);
    expect((mockSessionDB.getSession as any).mock.calls[0][0]).toBe("testSession");
    expect((mockSessionDB.getSessionWorkdir as any).mock.calls.length).toBe(1);
    expect((mockSessionDB.getSessionWorkdir as any).mock.calls[0][0]).toBe("testSession");
  });

  test("gets review info by task ID", async () => {
    const result = await sessionReviewFromParams(
      { task: "123" },
      deps
    );

    expect(result.session).toBe("task#123");
    expect(result.taskId).toBe("#123");
    expect((mockSessionDB.getSessionByTaskId as any).mock.calls.length).toBe(1);
    expect((mockSessionDB.getSessionByTaskId as any).mock.calls[0][0]).toBe("#123");
  });

  test("auto-detects current session when no parameters provided", async () => {
    const result = await sessionReviewFromParams(
      { repo: "/fake/repo/path" },
      deps
    );

    expect(result.session).toBe("testSession");
    expect(mockGetCurrentSession).toHaveBeenCalledWith("/fake/repo/path");
  });

  test("throws error when no session can be determined", async () => {
    (mockGetCurrentSession as any).mockImplementationOnce(() => Promise.resolve(null));

    await expect(
      sessionReviewFromParams({}, deps)
    ).rejects.toThrow(ValidationError);
  });

  test("throws error when session not found", async () => {
    (mockSessionDB.getSession as any).mockImplementationOnce(() => null);

    await expect(
      sessionReviewFromParams({ session: "nonexistent" }, deps)
    ).rejects.toThrow(ResourceNotFoundError);
  });
}); 

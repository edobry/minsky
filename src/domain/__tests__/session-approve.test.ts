import { describe, test, expect, mock, spyOn } from "bun:test";
import { TaskService, TASK_STATUS } from "../tasks";
import { approveSessionFromParams } from "../session";
import { MinskyError, ResourceNotFoundError, ValidationError } from "../../errors";

describe("Session Approve", () => {
  test("successfully approves and merges a PR branch", async () => {
    // Create mocks for dependencies
    const mockSessionDB = {
      getSession: mock((name: string) => Promise.resolve({
        session: name,
        repoName: "test-repo",
        repoUrl: "/test/repo/path",
        taskId: "#123"
      })),
      getSessionByTaskId: mock((taskId: string) => Promise.resolve({
        session: "test-session",
        repoName: "test-repo",
        repoUrl: "/test/repo/path",
        taskId
      })),
      getSessionWorkdir: mock((sessionName: string) => Promise.resolve("/test/workdir/test-repo/sessions/test-session"))
    };

    const mockGitService = {
      execInRepository: mock((workdir, command) => {
        if (command.includes("rev-parse HEAD")) {
          return Promise.resolve("abcdef123456");
        }
        if (command.includes("config user.name")) {
          return Promise.resolve("Test User");
        }
        return Promise.resolve("");
      })
    };

    const mockTaskService = {
      setTaskStatus: mock((id: string, status: string) => Promise.resolve()),
      getBackendForTask: mock((id: string) => Promise.resolve({
        setTaskMetadata: mock((id: string, metadata: any) => Promise.resolve())
      }))
    };

    const mockWorkspaceUtils = {
      getCurrentSessionContext: mock((repoPath: string) => Promise.resolve(null))
    };

    // Create test dependencies
    const testDeps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: mockWorkspaceUtils
    };

    // Test by session name
    const resultBySession = await approveSessionFromParams({
      session: "test-session"
    }, testDeps);

    // Verify
    expect(mockSessionDB.getSession).toHaveBeenCalledWith("test-session");
    expect(mockSessionDB.getSessionWorkdir).toHaveBeenCalledWith("test-session");
    expect(mockGitService.execInRepository).toHaveBeenCalled();
    expect(mockTaskService.setTaskStatus).toHaveBeenCalledWith("#123", "DONE");
    expect(resultBySession.commitHash).toBe("abcdef123456");
    expect(resultBySession.session).toBe("test-session");
    expect(resultBySession.taskId).toBe("#123");

    // Clear mocks
    mockSessionDB.getSession.mockClear();
    mockSessionDB.getSessionByTaskId.mockClear();
    mockSessionDB.getSessionWorkdir.mockClear();
    mockGitService.execInRepository.mockClear();
    mockTaskService.setTaskStatus.mockClear();
    mockTaskService.getBackendForTask.mockClear();

    // Test by task ID
    const resultByTask = await approveSessionFromParams({
      task: "#123"
    }, testDeps);

    // Verify
    expect(mockSessionDB.getSessionByTaskId).toHaveBeenCalledWith("#123");
    expect(mockGitService.execInRepository).toHaveBeenCalled();
    expect(mockTaskService.setTaskStatus).toHaveBeenCalledWith("#123", "DONE");
    expect(resultByTask.taskId).toBe("#123");
  });

  test("detects current session when repo path is provided", async () => {
    // Create mocks for dependencies
    const mockSessionDB = {
      getSession: mock((name: string) => Promise.resolve({
        session: name,
        repoName: "test-repo",
        repoUrl: "/test/repo/path"
      })),
      getSessionByTaskId: mock((taskId: string) => Promise.resolve(null)),
      getSessionWorkdir: mock((sessionName: string) => Promise.resolve("/test/workdir/test-repo/sessions/current-session"))
    };

    const mockGitService = {
      execInRepository: mock((workdir, command) => {
        if (command.includes("rev-parse HEAD")) {
          return Promise.resolve("abcdef123456");
        }
        if (command.includes("config user.name")) {
          return Promise.resolve("Test User");
        }
        return Promise.resolve("");
      })
    };

    const mockTaskService = {
      setTaskStatus: mock((id: string, status: string) => Promise.resolve()),
      getBackendForTask: mock((id: string) => Promise.resolve({
        setTaskMetadata: mock((id: string, metadata: any) => Promise.resolve())
      }))
    };

    const mockWorkspaceUtils = {
      getCurrentSessionContext: mock((repoPath: string) => Promise.resolve({
        sessionId: "current-session",
        taskId: "123"
      }))
    };

    // Create test dependencies
    const testDeps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: mockWorkspaceUtils
    };

    // Test auto detection
    const result = await approveSessionFromParams({
      repo: "/test/repo/path"
    }, testDeps);

    // Verify
    expect(mockWorkspaceUtils.getCurrentSessionContext).toHaveBeenCalledWith("/test/repo/path");
    expect(mockSessionDB.getSession).toHaveBeenCalledWith("current-session");
    expect(mockGitService.execInRepository).toHaveBeenCalled();
    expect(result.session).toBe("current-session");
  });

  test("throws error when session is not found", async () => {
    // Create mocks for dependencies
    const mockSessionDB = {
      getSession: mock((name: string) => Promise.resolve(null)),
      getSessionByTaskId: mock((taskId: string) => Promise.resolve(null)),
      getSessionWorkdir: mock((sessionName: string) => Promise.resolve(""))
    };

    // Create test dependencies
    const testDeps = {
      sessionDB: mockSessionDB,
      gitService: {},
      taskService: {},
      workspaceUtils: {}
    };

    // Test with non-existent session
    await expect(approveSessionFromParams({
      session: "non-existent-session"
    }, testDeps)).rejects.toThrow(ResourceNotFoundError);
  });

  test("throws error when no session or task is provided", async () => {
    // Create test dependencies
    const testDeps = {
      sessionDB: {},
      gitService: {},
      taskService: {},
      workspaceUtils: {
        getCurrentSessionContext: mock((repoPath: string) => Promise.resolve(null))
      }
    };

    // Test with no arguments
    await expect(approveSessionFromParams({
      repo: "/test/repo/path"
    }, testDeps)).rejects.toThrow(ValidationError);
  });

  test("handles errors during task metadata update", async () => {
    // Create mocks for dependencies
    const mockSessionDB = {
      getSession: mock((name: string) => Promise.resolve({
        session: name,
        repoName: "test-repo",
        repoUrl: "/test/repo/path",
        taskId: "#123"
      })),
      getSessionWorkdir: mock((sessionName: string) => Promise.resolve("/test/workdir/test-repo/sessions/test-session"))
    };

    const mockGitService = {
      execInRepository: mock((workdir, command) => {
        if (command.includes("rev-parse HEAD")) {
          return Promise.resolve("abcdef123456");
        }
        if (command.includes("config user.name")) {
          return Promise.resolve("Test User");
        }
        return Promise.resolve("");
      })
    };

    const mockTaskService = {
      setTaskStatus: mock((id: string, status: string) => Promise.reject(new Error("Task update failed"))),
      getBackendForTask: mock((id: string) => Promise.resolve({
        setTaskMetadata: mock((id: string, metadata: any) => Promise.resolve())
      }))
    };

    // Create test dependencies
    const testDeps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: {}
    };

    // Should still succeed even if task update fails
    const result = await approveSessionFromParams({
      session: "test-session"
    }, testDeps);

    // Verify
    expect(result.commitHash).toBe("abcdef123456");
    expect(result.session).toBe("test-session");
  });
}); 

import { describe, test, expect, mock } from "bun:test";
import { sessionReviewImpl } from "./session/session-review-operations";
import { ResourceNotFoundError, ValidationError } from "../errors/index";
import { FakeGitService } from "./git/fake-git-service";
import { FakeSessionProvider } from "./session/fake-session-provider";
import { FakeTaskService } from "./tasks/fake-task-service";
import { FakeWorkspaceUtils } from "./workspace/fake-workspace-utils";

describe("sessionReviewImpl", () => {
  test("reviews session by name", async () => {
    // Create trackable spies for methods we need to verify
    const getSessionSpy = mock((name: unknown) =>
      Promise.resolve({
        session: name as string,
        taskId: "123",
        repoName: "test-repo",
        repoUrl: "https://github.com/test/test-repo",
        branch: "feature/test",
        createdAt: new Date().toISOString(),
      })
    );

    const getSessionWorkdirSpy = mock((_sessionId: unknown) =>
      Promise.resolve("/fake/path/to/session")
    );

    const getTaskSpecDataSpy = mock(() =>
      Promise.resolve({ title: "Test Task", description: "Test description" })
    );

    // Create mocks using centralized factories with spy integration
    const mockSessionDB = new FakeSessionProvider();
    mockSessionDB.getSession = getSessionSpy;
    mockSessionDB.getSessionWorkdir = getSessionWorkdirSpy as any;

    const mockGitService = new FakeGitService();

    const mockTaskService = Object.assign(new FakeTaskService(), {
      getTaskSpecData: getTaskSpecDataSpy,
    });

    const mockWorkspaceUtils = new FakeWorkspaceUtils();

    const getCurrentSessionSpy = mock((_cwd?: unknown) => Promise.resolve("testSession"));

    const deps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: mockWorkspaceUtils,
      getCurrentSession: getCurrentSessionSpy as any,
    };

    // Test the sessionReview functionality
    const result = await sessionReviewImpl({ sessionId: "testSession" }, deps as any);

    // Verify calls with individual spies
    expect(getSessionSpy).toHaveBeenCalledWith("testSession");
    expect(getSessionWorkdirSpy).toHaveBeenCalledWith("testSession");

    // Verify result structure
    expect(result.session).toBe("testSession");
    expect(result.taskId).toBe("123");
    // The repository backend should have resolved the PR branch from session data
    expect(result.prBranch).toBeDefined();
  });

  test("reviews session by task ID", async () => {
    // Create trackable spies for methods we need to verify
    const getSessionByTaskIdSpy = mock((taskId: unknown) =>
      Promise.resolve({
        session: "task123",
        taskId: taskId as string,
        repoName: "test-repo",
        repoUrl: "https://github.com/test/test-repo",
        branch: "feature/test",
        createdAt: new Date().toISOString(),
      })
    );

    const getSessionSpy = mock((name: unknown) =>
      Promise.resolve({
        session: name as string,
        taskId: "123",
        repoName: "test-repo",
        repoUrl: "https://github.com/test/test-repo",
        branch: "feature/test",
        createdAt: new Date().toISOString(),
      })
    );

    const getSessionWorkdirSpy = mock((_sessionId: unknown) =>
      Promise.resolve("/fake/path/to/session")
    );

    // Create mocks using centralized factories with spy integration
    const mockSessionDB = new FakeSessionProvider();
    mockSessionDB.getSession = getSessionSpy;
    mockSessionDB.getSessionByTaskId = getSessionByTaskIdSpy;
    mockSessionDB.getSessionWorkdir = getSessionWorkdirSpy as any;

    const mockGitService = new FakeGitService();

    const mockTaskService = Object.assign(new FakeTaskService(), {
      getTaskSpecData: mock(() =>
        Promise.resolve({ title: "Test Task", description: "Test description" })
      ),
    });

    const mockWorkspaceUtils = new FakeWorkspaceUtils();

    const getCurrentSessionSpy = mock((_cwd?: unknown) => Promise.resolve("testSession"));

    const deps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: mockWorkspaceUtils,
      getCurrentSession: getCurrentSessionSpy as any,
    };

    // Test by task ID
    const result = await sessionReviewImpl({ task: "md#123" }, deps as any);

    // Verify calls with individual spies
    expect(getSessionByTaskIdSpy).toHaveBeenCalledWith("md#123");
    expect(getSessionWorkdirSpy).toHaveBeenCalledWith("task123");

    // Verify result
    expect(result.taskId).toBe("md#123");
    // The repository backend should have resolved the PR branch from session data
    expect(result.prBranch).toBeDefined();
  });

  test("throws ValidationError when no session detected", async () => {
    // Create mocks using centralized factories
    const mockSessionDB = new FakeSessionProvider();
    mockSessionDB.getSession = () => Promise.resolve(null);
    mockSessionDB.getSessionByTaskId = () => Promise.resolve(null);

    const mockGitService = new FakeGitService();
    const mockTaskService = new FakeTaskService();

    const mockWorkspaceUtils = new FakeWorkspaceUtils();

    const getCurrentSessionSpy = mock((_cwd?: unknown) => Promise.resolve(null));

    const deps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: mockWorkspaceUtils,
      getCurrentSession: getCurrentSessionSpy as any,
    };

    // Test error case
    try {
      await sessionReviewImpl({ repo: "/test/repo/path" }, deps as any);
      // Should not reach this point
      expect(false).toBe(true);
    } catch (error) {
      expect(error instanceof ValidationError).toBe(true);
      expect((error as Error).message).toContain("No session detected");
    }
  });

  test("throws ResourceNotFoundError when session not found", async () => {
    // Create mocks using centralized factories
    const mockSessionDB = new FakeSessionProvider();
    mockSessionDB.getSession = () => Promise.resolve(null);

    const mockGitService = new FakeGitService();
    const mockTaskService = new FakeTaskService();

    const mockWorkspaceUtils = new FakeWorkspaceUtils();

    const deps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: mockWorkspaceUtils,
      getCurrentSession: mock(() => Promise.resolve("testSession")),
    };

    // Test with non-existent session
    try {
      await sessionReviewImpl({ sessionId: "non-existent-session" }, deps as any);
      // Should not reach this point
      expect(false).toBe(true);
    } catch (error) {
      expect(error instanceof ResourceNotFoundError).toBe(true);
      expect((error as Error).message).toContain('Session "non-existent-session" not found');
    }
  });
});

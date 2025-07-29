import { describe, test, expect, mock } from "bun:test";
import { sessionReviewFromParams } from "./session";
import { ResourceNotFoundError, ValidationError } from "../errors/index";
import { createMock, createPartialMock } from "../utils/test-utils/mocking";
import {
  createMockSessionProvider,
  createMockGitService,
  createMockTaskService,
} from "../utils/test-utils/dependencies";
import type { WorkspaceUtilsInterface } from "./workspace";

const TEST_VALUE = 123;
const TEST_ARRAY_SIZE = 3;

describe("sessionReviewFromParams", () => {
  test("reviews session by name", async () => {
    // Create trackable spies for methods we need to verify
    let getSessionSpy = createMock();
    getSessionSpy = mock((name: unknown) =>
      Promise.resolve({
        session: name as string,
        taskId: "123",
        repoName: "test-repo",
        repoUrl: "https://github.com/test/test-repo",
        branch: "feature/test",
        createdAt: new Date().toISOString(),
      })
    );

    let getSessionWorkdirSpy = createMock();
    getSessionWorkdirSpy = mock((_sessionName: unknown) =>
      Promise.resolve("/fake/path/to/session")
    );

    let execInRepositorySpy = createMock();
    execInRepositorySpy = mock((_workdir: unknown, command: unknown) => {
      const cmd = command as string;
      if (cmd.includes("git ls-remote")) {
        return Promise.resolve("refs/heads/pr/testSession");
      }
      if (cmd.includes("log -1")) {
        return Promise.resolve("PR Title\n\nPR Description body");
      }
      if (cmd.includes("diff --stat")) {
        return Promise.resolve("3 files changed, 10 insertions(+), TEST_ARRAY_SIZE deletions(-)");
      }
      if (cmd.includes("git diff")) {
        return Promise.resolve("diff --git a/file.txt b/file.txt\n+new line\n-old line");
      }
      return Promise.resolve("");
    });

    let getTaskSpecDataSpy = createMock();
    getTaskSpecDataSpy = mock(() =>
      Promise.resolve({ title: "Test Task", description: "Test description" })
    );

    // Create mocks using centralized factories with spy integration
    const mockSessionDB = createMockSessionProvider({
      getSession: getSessionSpy as any,
      getSessionWorkdir: getSessionWorkdirSpy as any,
    });

    const mockGitService = createMockGitService({
      execInRepository: execInRepositorySpy as any,
    });

    const mockTaskService = createMockTaskService({});

    // Add getTaskSpecData method not covered by centralized factory
    (mockTaskService as any).getTaskSpecData = getTaskSpecDataSpy;

    const mockWorkspaceUtils = createPartialMock<WorkspaceUtilsInterface>({
      isSessionWorkspace: () => false,
    });

    let getCurrentSessionSpy = createMock();
    getCurrentSessionSpy = mock((_cwd?: unknown) => Promise.resolve("testSession"));

    const deps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: mockWorkspaceUtils,
      getCurrentSession: getCurrentSessionSpy as any,
    };

    // Test the sessionReview functionality
    const result = await sessionReviewFromParams({ session: "testSession" }, deps);

    // Verify calls with individual spies
    expect(getSessionSpy).toHaveBeenCalledWith("testSession");
    expect(getSessionWorkdirSpy).toHaveBeenCalledWith("testSession");
    expect(execInRepositorySpy.mock.calls.length).toBeGreaterThan(0);

    // Verify result structure
    expect(result.session).toBe("testSession");
    expect(result.taskId).toBe("123");
  });

  test("reviews session by task ID", async () => {
    // Create trackable spies for methods we need to verify
    let getSessionByTaskIdSpy = createMock();
    getSessionByTaskIdSpy = mock((taskId: unknown) =>
      Promise.resolve({
        session: "task123",
        taskId: taskId as string,
        repoName: "test-repo",
        repoUrl: "https://github.com/test/test-repo",
        branch: "feature/test",
        createdAt: new Date().toISOString(),
      })
    );

    let getSessionSpy = createMock();
    getSessionSpy = mock((name: unknown) =>
      Promise.resolve({
        session: name as string,
        taskId: "123",
        repoName: "test-repo",
        repoUrl: "https://github.com/test/test-repo",
        branch: "feature/test",
        createdAt: new Date().toISOString(),
      })
    );

    let getSessionWorkdirSpy = createMock();
    getSessionWorkdirSpy = mock((_sessionName: unknown) =>
      Promise.resolve("/fake/path/to/session")
    );

    let execInRepositorySpy = createMock();
    execInRepositorySpy = mock((_workdir: unknown, command: unknown) => {
      const cmd = command as string;
      if (cmd.includes("git ls-remote")) {
        return Promise.resolve("refs/heads/pr/task123");
      }
      if (cmd.includes("log -1")) {
        return Promise.resolve("PR Title\n\nPR Description body");
      }
      if (cmd.includes("diff --stat")) {
        return Promise.resolve("3 files changed, 10 insertions(+), TEST_ARRAY_SIZE deletions(-)");
      }
      if (cmd.includes("git diff")) {
        return Promise.resolve("diff --git a/file.txt b/file.txt\n+new line\n-old line");
      }
      return Promise.resolve("");
    });

    // Create mocks using centralized factories with spy integration
    const mockSessionDB = createMockSessionProvider({
      getSession: getSessionSpy as any,
      getSessionByTaskId: getSessionByTaskIdSpy as any,
      getSessionWorkdir: getSessionWorkdirSpy as any,
    });

    const mockGitService = createMockGitService({
      execInRepository: execInRepositorySpy as any,
    });

    const mockTaskService = createMockTaskService({});

    // Add getTaskSpecData method not covered by centralized factory
    (mockTaskService as any).getTaskSpecData = createMock(() =>
      Promise.resolve({ title: "Test Task", description: "Test description" })
    );

    const mockWorkspaceUtils = createPartialMock<WorkspaceUtilsInterface>({
      isSessionWorkspace: () => false,
    });

    let getCurrentSessionSpy = createMock();
    getCurrentSessionSpy = mock((_cwd?: unknown) => Promise.resolve("testSession"));

    const deps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: mockWorkspaceUtils,
      getCurrentSession: getCurrentSessionSpy as any,
    };

    // Test by task ID
    const result = await sessionReviewFromParams({ task: "#123" }, deps);

    // Verify calls with individual spies
    expect(getSessionByTaskIdSpy).toHaveBeenCalledWith("123");
    expect(getSessionWorkdirSpy).toHaveBeenCalledWith("task123");
    expect(execInRepositorySpy.mock.calls.length).toBeGreaterThan(0);

    // Verify result
    expect(result.taskId).toBe("123");
  });

  test("throws ValidationError when no session detected", async () => {
    // Create mocks using centralized factories
    const mockSessionDB = createMockSessionProvider({
      getSession: () => Promise.resolve(null),
      getSessionByTaskId: () => Promise.resolve(null),
    });

    const mockGitService = createMockGitService({});
    const mockTaskService = createMockTaskService({});

    const mockWorkspaceUtils = createPartialMock<WorkspaceUtilsInterface>({
      isSessionWorkspace: () => false,
    });

    let getCurrentSessionSpy = createMock();
    getCurrentSessionSpy = mock((_cwd?: unknown) => Promise.resolve(null));

    const deps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: mockWorkspaceUtils,
      getCurrentSession: getCurrentSessionSpy as any,
    };

    // Test error case
    try {
      await sessionReviewFromParams({ repo: "/test/repo/path" }, deps);
      // Should not reach this point
      expect(false).toBe(true);
    } catch (error) {
      expect(error instanceof ValidationError).toBe(true);
      expect((error as Error).message).toContain("No session detected");
    }
  });

  test("throws ResourceNotFoundError when session not found", async () => {
    // Create mocks using centralized factories
    const mockSessionDB = createMockSessionProvider({
      getSession: () => Promise.resolve(null),
    });

    const mockGitService = createMockGitService({});
    const mockTaskService = createMockTaskService({});

    const mockWorkspaceUtils = createPartialMock<WorkspaceUtilsInterface>({
      isSessionWorkspace: () => false,
    });

    const deps = {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: mockWorkspaceUtils,
      getCurrentSession: createMock(() => Promise.resolve("testSession")) as any,
    };

    // Test with non-existent session
    try {
      await sessionReviewFromParams({ session: "non-existent-session" }, deps);
      // Should not reach this point
      expect(false).toBe(true);
    } catch (error) {
      expect(error instanceof ResourceNotFoundError).toBe(true);
      expect((error as Error).message).toContain('Session "non-existent-session" not found');
    }
  });
});

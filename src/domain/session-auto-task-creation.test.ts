/**
 * Session Auto-Task Creation Integration Tests
 * 
 * Tests the new auto-creation functionality for tasks when starting sessions
 * with the --description parameter.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { startSessionFromParams, type SessionProviderInterface } from "./session";
import type { TaskServiceInterface } from "./tasks";
import type { GitServiceInterface } from "./git";
import type { WorkspaceUtilsInterface } from "./workspace";
import { createMock, createPartialMock } from "../utils/test-utils/mocking";
import { createMockSessionProvider, createMockGitService, createMockTaskService } from "../utils/test-utils/dependencies";

describe("Session Auto-Task Creation", () => {
  let mockSessionDB: SessionProviderInterface;
  let mockGitService: GitServiceInterface;
  let mockTaskService: TaskServiceInterface;
  let mockWorkspaceUtils: WorkspaceUtilsInterface;
  let mockResolveRepoPath: (params: any) => Promise<string>;
  let createTaskFromTitleAndDescriptionSpy: any;

  beforeEach(() => {
    // Create spy for the method we want to track using createMock for proper Bun test tracking
    createTaskFromTitleAndDescriptionSpy = createMock();
    createTaskFromTitleAndDescriptionSpy.mockImplementation((title: string, description: string) => Promise.resolve({
      id: "#001",
      title,
      description,
      status: "TODO",
    }));

    // Mock session database using centralized factory
    mockSessionDB = createMockSessionProvider({
      getSession: () => Promise.resolve(null),
      addSession: () => Promise.resolve(void 0),
      listSessions: () => Promise.resolve([]),
      deleteSession: () => Promise.resolve(true),
    });

    // Mock git service using centralized factory
    mockGitService = createMockGitService({
      clone: () => Promise.resolve({
        session: "test-session",
        repoUrl: "test-repo",
        repoName: "test-repo",
        branch: "test-session",
        workdir: "/test/workdir",
      }),
    });

    // Add the branchWithoutSession method that's not in our centralized factory
    (mockGitService as any).branchWithoutSession = () => Promise.resolve({
      branch: "test-session",
      workdir: "/test/workdir",
    });

    // Mock task service using centralized factory
    mockTaskService = createMockTaskService({
      createTaskFromTitleAndDescription: createTaskFromTitleAndDescriptionSpy,
      setTaskStatus: () => Promise.resolve(void 0),
      listTasks: () => Promise.resolve([]),
      getTaskStatus: () => Promise.resolve("TODO"),
      getWorkspacePath: () => "/test/workspace",
      createTask: () => Promise.resolve({
        id: "#001",
        title: "Test Task",
        status: "TODO",
      }),
      deleteTask: () => Promise.resolve(true),
      getBackendForTask: () => Promise.resolve("markdown"),
    });

    // Add the getTask method that's not in our centralized factory
    (mockTaskService as any).getTask = () => Promise.resolve({
      id: "#001",
      title: "Test Task",
      status: "TODO",
    });

    // Mock workspace utils using createPartialMock since we don't have a centralized factory for this
    mockWorkspaceUtils = createPartialMock<WorkspaceUtilsInterface>({
      isSessionWorkspace: () => false,
    });

    // Mock resolve repo path
    mockResolveRepoPath = () => Promise.resolve("test-repo");
  });

  test("should auto-create task when description is provided", async () => {
    const params = {
      description: "Fix the authentication bug",
      quiet: false,
      noStatusUpdate: false,
      skipInstall: true,
    };

    const result = await startSessionFromParams(params, {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: mockWorkspaceUtils,
      resolveRepoPath: mockResolveRepoPath,
    });

    // Verify task was created
    expect(createTaskFromTitleAndDescriptionSpy).toHaveBeenCalledWith(
      "Fix the authentication bug",
      "Auto-created task for session: Fix the authentication bug"
    );

    // Verify session was created with task ID
    expect(result.taskId).toBe("#001");
    expect(result.session).toBe("task#001");
  });

  test("should not auto-create task when task ID is provided", async () => {
    const params = {
      task: "001",
      description: "Fix the authentication bug",
      quiet: false,
      noStatusUpdate: false,
      skipInstall: true,
    };

    await startSessionFromParams(params, {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: mockWorkspaceUtils,
      resolveRepoPath: mockResolveRepoPath,
    });

    // Verify task was NOT auto-created since task ID was provided
    expect(createTaskFromTitleAndDescriptionSpy).not.toHaveBeenCalled();
  });

  test("should use session name when provided with description", async () => {
    const params = {
      name: "custom-session",
      description: "Fix the authentication bug",
      quiet: false,
      noStatusUpdate: false,
      skipInstall: true,
    };

    const result = await startSessionFromParams(params, {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: mockWorkspaceUtils,
      resolveRepoPath: mockResolveRepoPath,
    });

    // Verify task was created
    expect(createTaskFromTitleAndDescriptionSpy).toHaveBeenCalled();

    // Verify session name is the provided name, not auto-generated
    expect(result.session).toBe("custom-session");
    expect(result.taskId).toBe("#001");
  });
}); 

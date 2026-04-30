/**
 * Session Auto-Task Creation Integration Tests
 *
 * Tests the new auto-creation functionality for tasks when starting sessions
 * with the --description parameter.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { startSessionImpl } from "./session/start-session-operations";
import type { SessionStartParameters } from "./schemas";
import type { SessionProviderInterface } from "./session";
import type { TaskServiceInterface } from "./tasks";
import type { GitServiceInterface } from "./git";
import type { WorkspaceUtilsInterface } from "./workspace";
import { FakeTaskService } from "./tasks/fake-task-service";
import { initializeConfiguration, CustomConfigFactory } from "./configuration";
import { RepositoryBackendType } from "./repository";
import { FakeSessionProvider } from "./session/fake-session-provider";
import { FakeGitService } from "./git/fake-git-service";
import { FakeWorkspaceUtils } from "./workspace/fake-workspace-utils";

const TEST_REPO_URL = "https://github.com/test/repo.git";

function makeGetRepositoryBackend(repoUrl = TEST_REPO_URL) {
  return async () => ({
    repoUrl,
    backendType: RepositoryBackendType.GITHUB as RepositoryBackendType,
    github: { owner: "test", repo: "repo" },
  });
}

describe("Session Auto-Task Creation", () => {
  let mockSessionDB: SessionProviderInterface;
  let mockGitService: GitServiceInterface;
  let mockTaskService: TaskServiceInterface;
  let mockWorkspaceUtils: WorkspaceUtilsInterface;
  let createTaskSpy: any;

  beforeEach(async () => {
    // Initialize configuration to avoid initialization errors
    const factory = new CustomConfigFactory();
    await initializeConfiguration(factory, { workingDirectory: "/mock/workspace" });

    // Create spy for tracking task creation
    createTaskSpy = mock(() =>
      Promise.resolve({
        id: "md#001", // Use qualified format to match expectations
        title: "Test Task",
        description: "Test Description",
        status: "TODO",
      })
    );

    // Mock session database using centralized factory
    mockSessionDB = new FakeSessionProvider();

    // Mock git service using FakeGitService for full control
    const fakeGitService = new FakeGitService();
    fakeGitService.clone = () =>
      Promise.resolve({
        session: "test-session",
        repoUrl: "test-repo",
        repoName: "test-repo",
        branch: "test-session",
        workdir: "/test/workdir",
      });
    fakeGitService.branchWithoutSession = () =>
      Promise.resolve({
        branch: "test-session",
        workdir: "/test/workdir",
      });
    mockGitService = fakeGitService;

    // Mock task service using FakeTaskService with proper task creation mock
    const fakeTaskService = new FakeTaskService({
      initialTasks: [{ id: "md#001", title: "Test Task", status: "READY" }],
      workspacePath: "/test/workspace",
    });
    fakeTaskService.createTaskFromTitleAndSpec = createTaskSpy;
    fakeTaskService.deleteTask = () => Promise.resolve(true);
    mockTaskService = fakeTaskService;

    // Mock workspace utils using FakeWorkspaceUtils
    mockWorkspaceUtils = new FakeWorkspaceUtils();
  });

  test("should auto-create task when description is provided", async () => {
    const params = {
      repo: TEST_REPO_URL,
      description: "Fix the authentication bug", // Provided for auto-creation
      // No taskId or sessionId provided - both should be auto-generated
    };

    const result = await startSessionImpl(params as unknown as SessionStartParameters, {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: mockWorkspaceUtils,
      getRepositoryBackend: makeGetRepositoryBackend(),
    });

    // Verify session was created with task ID (qualified format)
    expect(result.taskId).toBe("md#001"); // Code returns qualified ID format
    // Session ID is now a UUID (opaque, no task info encoded)
    expect(result.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  test("should not auto-create task when task ID is provided", async () => {
    const params = {
      task: "md#001",
      repo: TEST_REPO_URL,
      // sessionId will be auto-generated from taskId
    };

    await startSessionImpl(params as unknown as SessionStartParameters, {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: mockWorkspaceUtils,
      getRepositoryBackend: makeGetRepositoryBackend(),
    });

    // Since task ID was provided, the auto-creation flow shouldn't be used
    expect(createTaskSpy).not.toHaveBeenCalled();
  });

  test("should use session ID when provided with description", async () => {
    const params = {
      sessionId: "custom-session",
      repo: TEST_REPO_URL,
      description: "Fix the authentication bug", // Provided for auto-creation
      // No task provided - should auto-create from description
    };

    const result = await startSessionImpl(params as unknown as SessionStartParameters, {
      sessionDB: mockSessionDB,
      gitService: mockGitService,
      taskService: mockTaskService,
      workspaceUtils: mockWorkspaceUtils,
      getRepositoryBackend: makeGetRepositoryBackend(),
    });

    // Verify session ID is the provided name, not auto-generated
    expect(result.sessionId).toBe("custom-session");
    expect(result.taskId).toBe("md#001"); // When custom session ID provided, returns qualified task ID
  });
});

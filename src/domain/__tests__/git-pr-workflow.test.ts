import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { approveSessionFromParams } from "../session";
import { GitService } from "../git";
import { TaskService } from "../tasks";
import { MinskyError, ResourceNotFoundError, ValidationError } from "../../errors";
import { createMock } from "../../utils/test-utils/mocking";
import * as WorkspaceUtils from "../workspace";

describe("Session Approve Workflow", () => {
  // Create mocks for dependencies
  const mockGitService = {
    execInRepository: createMock((workdir, command) => {
      if (command.includes("rev-parse HEAD")) {
        return Promise.resolve("abc123");
      }
      if (command.includes("config user.name")) {
        return Promise.resolve("test-user");
      }
      return Promise.resolve("Successfully merged PR");
    })
  };
  
  const mockTaskService = {
    getTask: createMock((id) => 
      Promise.resolve({
        id,
        title: "Test Task",
        description: "A test task",
        status: "in-progress",
      })
    ),
    setTaskStatus: createMock(() => Promise.resolve(true)),
  };
  
  const mockSessionDB = {
    getSession: createMock((name) => 
      Promise.resolve({
        session: name,
        repoName: "test-repo",
        repoUrl: "/test/repo/path",
        backendType: "local",
        remote: { authMethod: "ssh", depth: 1 },
        createdAt: new Date().toISOString(),
        taskId: "task025",
      })
    ),
    getSessionWorkdir: createMock(() => Promise.resolve("/test/repo/path/sessions/test-session")),
    getSessionByTaskId: createMock(() => Promise.resolve(null)),
  };
  
  // Reset mocks before each test
  beforeEach(() => {
    // Clear mock calls
    mockGitService.execInRepository.mockClear();
    mockTaskService.getTask.mockClear();
    mockTaskService.setTaskStatus.mockClear();
    mockSessionDB.getSession.mockClear();
    mockSessionDB.getSessionWorkdir.mockClear();
    mockSessionDB.getSessionByTaskId.mockClear();
  });
  
  test("successfully approves and merges a PR branch with task ID", async () => {
    const result = await approveSessionFromParams(
      { session: "test-session" },
      {
        gitService: mockGitService as unknown as GitService,
        taskService: mockTaskService as unknown as TaskService, 
        sessionDB: mockSessionDB as any,
        workspaceUtils: WorkspaceUtils,
      }
    );
    
    // Verify results
    expect(result.session).toBe("test-session");
    expect(result.commitHash).toBe("abc123");
    expect(result.mergeDate).toBeDefined();
    expect(result.mergedBy).toBe("test-user");
    expect(result.taskId).toBe("task025");
    
    // Verify methods were called with expected parameters
    expect(mockSessionDB.getSession).toHaveBeenCalledWith("test-session");
    
    expect(mockGitService.execInRepository).toHaveBeenCalled();
    
    // Verify task status was updated
    expect(mockTaskService.setTaskStatus).toHaveBeenCalled();
    expect(mockTaskService.setTaskStatus.mock.calls[0]?.[0]).toBe("task025");
  });
  
  test("throws ValidationError when session parameter is missing", async () => {
    await expect(approveSessionFromParams({}, {
      gitService: mockGitService as unknown as GitService,
      taskService: mockTaskService as unknown as TaskService,
      sessionDB: mockSessionDB as any,
      workspaceUtils: WorkspaceUtils,
    })).rejects.toThrow(/No session detected/);
  });
  
  test("throws ResourceNotFoundError when session does not exist", async () => {
    // Override the getSession mock to return null (session not found)
    const originalGetSession = mockSessionDB.getSession;
    mockSessionDB.getSession = createMock(() => Promise.resolve(null));
    
    try {
      await expect(approveSessionFromParams(
        { session: "non-existent-session" },
        {
          gitService: mockGitService as unknown as GitService,
          taskService: mockTaskService as unknown as TaskService,
          sessionDB: mockSessionDB as any,
          workspaceUtils: WorkspaceUtils,
        }
      )).rejects.toThrow(/Session "non-existent-session" not found/);
    } finally {
      // Restore the original mock
      mockSessionDB.getSession = originalGetSession;
    }
  });
  
  test("throws MinskyError when git command fails", async () => {
    // Override the execInRepository mock to throw an error
    const originalExecIn = mockGitService.execInRepository;
    mockGitService.execInRepository = createMock(() => Promise.reject(new Error("Git command failed")));
    
    try {
      await expect(approveSessionFromParams(
        { session: "test-session" },
        {
          gitService: mockGitService as unknown as GitService,
          taskService: mockTaskService as unknown as TaskService,
          sessionDB: mockSessionDB as any, 
          workspaceUtils: WorkspaceUtils,
        }
      )).rejects.toThrow(/Failed to approve session/);
    } finally {
      // Restore the original mock
      mockGitService.execInRepository = originalExecIn;
    }
  });
}); 

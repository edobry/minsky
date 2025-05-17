import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { approveSessionFromParams } from "../session";
import { GitService } from "../git";
import { TaskService } from "../tasks";
import { MinskyError, ResourceNotFoundError, ValidationError } from "../../errors";
import { createMock } from "../../utils/test-utils/mocking";

describe("Session Approve Workflow", () => {
  // Create mocks for dependencies
  const mockGitService = {
    execInRepository: createMock(() => 
      Promise.resolve("Successfully merged PR\nCommit: abc123\nMerge date: 2025-01-01\nUser: test-user")
    ),
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
    setTaskMetadata: createMock(() => Promise.resolve(true)),
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
  };
  
  // Reset mocks before each test
  beforeEach(() => {
    (mockGitService.execInRepository as any).mock.calls = [];
    (mockTaskService.getTask as any).mock.calls = [];
    (mockTaskService.setTaskMetadata as any).mock.calls = [];
    (mockSessionDB.getSession as any).mock.calls = [];
  });
  
  test("successfully approves and merges a PR branch with task ID", async () => {
    const result = await approveSessionFromParams(
      { session: "test-session" },
      {
        gitService: mockGitService as unknown as GitService,
        taskService: mockTaskService as unknown as TaskService, 
        sessionDB: mockSessionDB,
        workspacePath: "/test/repo/path",
      }
    );
    
    // Verify results
    expect(result.session).toBe("test-session");
    expect(result.commitHash).toBe("abc123");
    expect(result.mergeDate).toBeDefined();
    expect(result.mergedBy).toBeDefined();
    expect(result.taskId).toBe("task025");
    
    // Verify methods were called with expected parameters
    expect((mockSessionDB.getSession as any).mock.calls.length).toBe(1);
    expect((mockSessionDB.getSession as any).mock.calls[0][0]).toBe("test-session");
    
    expect((mockGitService.execInRepository as any).mock.calls.length).toBeGreaterThan(0);
    
    // Verify task metadata was updated
    expect((mockTaskService.setTaskMetadata as any).mock.calls.length).toBe(1);
    expect((mockTaskService.setTaskMetadata as any).mock.calls[0][0]).toBe("task025");
  });
  
  test("throws ValidationError when session parameter is missing", async () => {
    await expect(approveSessionFromParams({}, {
      gitService: mockGitService as unknown as GitService,
      taskService: mockTaskService as unknown as TaskService,
      sessionDB: mockSessionDB,
      workspacePath: "/test/repo/path",
    })).rejects.toBeInstanceOf(ValidationError);
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
          sessionDB: mockSessionDB,
          workspacePath: "/test/repo/path",
        }
      )).rejects.toBeInstanceOf(ResourceNotFoundError);
    } finally {
      // Restore the original mock
      mockSessionDB.getSession = originalGetSession;
    }
  });
  
  test("throws MinskyError when git command fails", async () => {
    // Override the execInRepository mock to throw an error
    const originalExecIn = mockGitService.execInRepository;
    mockGitService.execInRepository = createMock(() => 
      Promise.reject(new Error("Git command failed"))
    );
    
    try {
      await expect(approveSessionFromParams(
        { session: "test-session" },
        {
          gitService: mockGitService as unknown as GitService,
          taskService: mockTaskService as unknown as TaskService,
          sessionDB: mockSessionDB, 
          workspacePath: "/test/repo/path",
        }
      )).rejects.toBeInstanceOf(MinskyError);
    } finally {
      // Restore the original mock
      mockGitService.execInRepository = originalExecIn;
    }
  });
}); 

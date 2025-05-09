import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { startSession } from "../startSession";
import { TaskService, TASK_STATUS } from "../../../domain/tasks";

describe("Session start command with automatic status update", () => {
  // Mocks
  const mockTaskService = {
    getTask: mock(() => Promise.resolve({ id: "#123", title: "Test Task", status: TASK_STATUS.TODO })),
    getTaskStatus: mock(() => Promise.resolve(TASK_STATUS.TODO)),
    setTaskStatus: mock(() => Promise.resolve())
  };

  const mockSessionDB = {
    getSession: mock(() => Promise.resolve(null)),
    listSessions: mock(() => Promise.resolve([])),
    addSession: mock(() => Promise.resolve())
  };

  const mockGitService = {
    clone: mock(() => Promise.resolve({ workdir: "/fake/path" })),
    branch: mock(() => Promise.resolve({ branch: "task#123" }))
  };

  const mockResolveRepoPath = mock(() => Promise.resolve("/fake/repo/path"));

  // Reset mocks between tests
  beforeEach(() => {
    mock.resetAll();
  });

  test("should update task status to IN-PROGRESS by default", async () => {
    const result = await startSession({
      taskId: "123",
      gitService: mockGitService,
      sessionDB: mockSessionDB,
      resolveRepoPath: mockResolveRepoPath,
      taskService: mockTaskService as unknown as TaskService
    });

    // Assert task status is updated
    expect(mockTaskService.getTaskStatus).toHaveBeenCalledWith("#123");
    expect(mockTaskService.setTaskStatus).toHaveBeenCalledWith("#123", TASK_STATUS.IN_PROGRESS);
    
    // Assert status update result is included
    expect(result.statusUpdateResult).toBeDefined();
    expect(result.statusUpdateResult?.taskId).toBe("#123");
    expect(result.statusUpdateResult?.previousStatus).toBe(TASK_STATUS.TODO);
    expect(result.statusUpdateResult?.newStatus).toBe(TASK_STATUS.IN_PROGRESS);
  });

  test("should not update task status when noStatusUpdate flag is true", async () => {
    const result = await startSession({
      taskId: "123",
      noStatusUpdate: true,
      gitService: mockGitService,
      sessionDB: mockSessionDB,
      resolveRepoPath: mockResolveRepoPath,
      taskService: mockTaskService as unknown as TaskService
    });

    // Assert task status is not updated
    expect(mockTaskService.setTaskStatus).not.toHaveBeenCalled();
    
    // Assert status update result is not included
    expect(result.statusUpdateResult).toBeUndefined();
  });

  test("should handle errors during status update without failing", async () => {
    // Make the setTaskStatus function throw an error
    mockTaskService.setTaskStatus.mockImplementationOnce(() => {
      throw new Error("Cannot update task status");
    });

    // Spy on console.error
    const consoleErrorSpy = mock.method(console, "error");

    const result = await startSession({
      taskId: "123",
      gitService: mockGitService,
      sessionDB: mockSessionDB,
      resolveRepoPath: mockResolveRepoPath,
      taskService: mockTaskService as unknown as TaskService
    });

    // Assert session was created despite status update error
    expect(mockSessionDB.addSession).toHaveBeenCalled();
    expect(mockGitService.clone).toHaveBeenCalled();
    expect(mockGitService.branch).toHaveBeenCalled();
    
    // Assert error was logged
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(consoleErrorSpy.mock.calls[0][0]).toContain("Warning: Failed to update status for task");
    
    // Assert status update result is not included
    expect(result.statusUpdateResult).toBeUndefined();

    // Restore console.error
    consoleErrorSpy.mockRestore();
  });
}); 

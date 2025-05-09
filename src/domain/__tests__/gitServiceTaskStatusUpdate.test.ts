import { describe, test, expect, mock, beforeEach } from "bun:test";
import { GitService, PrOptions, PrDependencies } from "../git";
import { TaskService, TASK_STATUS } from "../tasks";

describe("GitService task status update", () => {
  let gitService: GitService;
  
  // Mock dependencies
  const mockExecAsync = mock(() => Promise.resolve({ stdout: "", stderr: "" }));
  const mockGetSession = mock(() => Promise.resolve({ session: "test-session", taskId: "#123", repoName: "test-repo" }));
  const mockGetSessionByTaskId = mock(() => Promise.resolve({ session: "test-session", taskId: "#123", repoName: "test-repo" }));
  const mockGetSessionWorkdir = mock(() => "/test/workdir");
  
  const mockDeps: PrDependencies = {
    execAsync: mockExecAsync,
    getSession: mockGetSession,
    getSessionWorkdir: mockGetSessionWorkdir,
    getSessionByTaskId: mockGetSessionByTaskId
  };
  
  // Mock TaskService
  mock.module("../tasks", () => {
    return {
      TaskService: mock.fn().mockImplementation(() => ({
        getTaskStatus: mock(() => Promise.resolve(TASK_STATUS.TODO)),
        setTaskStatus: mock(() => Promise.resolve())
      })),
      TASK_STATUS: {
        TODO: "TODO",
        IN_PROGRESS: "IN-PROGRESS",
        IN_REVIEW: "IN-REVIEW",
        DONE: "DONE"
      }
    };
  });
  
  beforeEach(() => {
    gitService = new GitService("/test/basedir");
    mock.resetAll();
    
    // Set up execAsync mock to return current branch
    mockExecAsync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) {
        return Promise.resolve({ stdout: "task#123", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });
  });
  
  test("pr should update task status to IN-REVIEW when taskId is provided", async () => {
    // Mock the private methods
    const originalPrWithDeps = gitService.prWithDependencies;
    gitService.prWithDependencies = mock(() => Promise.resolve({ markdown: "Test PR" }));
    
    // Mock determineTaskId to expose it for testing
    const determineTaskId = mock(() => Promise.resolve("#123"));
    (gitService as any).determineTaskId = determineTaskId;
    
    // Create a spy for the setTaskStatus method
    const setTaskStatusSpy = mock(() => Promise.resolve());
    const getTaskStatusSpy = mock(() => Promise.resolve(TASK_STATUS.TODO));
    
    const taskServiceInstance = {
      getTaskStatus: getTaskStatusSpy,
      setTaskStatus: setTaskStatusSpy
    };
    
    // Mock the TaskService constructor
    (TaskService as any) = mock.fn().mockImplementation(() => taskServiceInstance);
    
    // Call the method
    const result = await gitService.pr({
      taskId: "#123",
      debug: true
    });
    
    // Assertions
    expect(gitService.prWithDependencies).toHaveBeenCalled();
    expect(taskServiceInstance.setTaskStatus).toHaveBeenCalledWith("#123", TASK_STATUS.IN_REVIEW);
    expect(result.statusUpdateResult).toBeDefined();
    expect(result.statusUpdateResult?.taskId).toBe("#123");
    expect(result.statusUpdateResult?.newStatus).toBe(TASK_STATUS.IN_REVIEW);
    
    // Restore original method
    gitService.prWithDependencies = originalPrWithDeps;
  });
  
  test("pr should skip task status update when noStatusUpdate is true", async () => {
    // Mock the private methods
    const originalPrWithDeps = gitService.prWithDependencies;
    gitService.prWithDependencies = mock(() => Promise.resolve({ markdown: "Test PR" }));
    
    // Mock determineTaskId to expose it for testing
    const determineTaskId = mock(() => Promise.resolve("#123"));
    (gitService as any).determineTaskId = determineTaskId;
    
    // Create a spy for the setTaskStatus method
    const setTaskStatusSpy = mock(() => Promise.resolve());
    const getTaskStatusSpy = mock(() => Promise.resolve(TASK_STATUS.TODO));
    
    const taskServiceInstance = {
      getTaskStatus: getTaskStatusSpy,
      setTaskStatus: setTaskStatusSpy
    };
    
    // Mock the TaskService constructor
    (TaskService as any) = mock.fn().mockImplementation(() => taskServiceInstance);
    
    // Call the method with noStatusUpdate = true
    const result = await gitService.pr({
      taskId: "#123",
      noStatusUpdate: true,
      debug: true
    });
    
    // Assertions
    expect(gitService.prWithDependencies).toHaveBeenCalled();
    expect(taskServiceInstance.setTaskStatus).not.toHaveBeenCalled();
    expect(result.statusUpdateResult).toBeUndefined();
    
    // Restore original method
    gitService.prWithDependencies = originalPrWithDeps;
  });
  
  test("determineTaskId should resolve task ID from branch name if not provided", async () => {
    // Access private method for testing
    const determineTaskId = (gitService as any).determineTaskId.bind(gitService);
    
    // Call with branch name that includes taskId
    const taskId = await determineTaskId(
      {}, // empty options
      "/test/workdir",
      "task#456", // branch name with task ID
      {
        ...mockDeps,
        execAsync: mock(() => Promise.resolve({ stdout: "", stderr: "" }))
      }
    );
    
    expect(taskId).toBe("#456");
  });
  
  test("determineTaskId should resolve task ID from session metadata", async () => {
    // Access private method for testing
    const determineTaskId = (gitService as any).determineTaskId.bind(gitService);
    
    // Call with session that has taskId in metadata
    const taskId = await determineTaskId(
      { session: "test-session" }, // options with session
      "/test/workdir",
      "some-branch", // branch without task ID
      {
        ...mockDeps,
        getSession: mock(() => Promise.resolve({ session: "test-session", taskId: "#789", repoName: "test-repo" }))
      }
    );
    
    expect(taskId).toBe("#789");
  });
}); 

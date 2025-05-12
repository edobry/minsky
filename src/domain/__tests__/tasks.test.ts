/**
 * Tests for interface-agnostic task functions
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { 
  listTasksFromParams, 
  getTaskFromParams, 
  getTaskStatusFromParams, 
  setTaskStatusFromParams 
} from "../tasks.js";
import { ValidationError, ResourceNotFoundError } from "../../errors/index.js";

// Mock dependencies
const mockTask = {
  id: "#123",
  title: "Test Task",
  status: "TODO",
  description: "This is a test task"
};

const mockTaskService = {
  listTasks: mock(() => [mockTask]),
  getTask: mock((id: string) => id === "#123" ? mockTask : null),
  getTaskStatus: mock((id: string) => id === "#123" ? "TODO" : null),
  setTaskStatus: mock(() => { /* mock implementation */ })
};

const mockResolveRepoPath = mock(() => Promise.resolve("/mock/repo/path"));
const mockResolveWorkspacePath = mock(() => Promise.resolve("/mock/workspace/path"));
const mockCreateTaskService = mock(() => mockTaskService);

const mockDeps = {
  resolveRepoPath: mockResolveRepoPath,
  resolveWorkspacePath: mockResolveWorkspacePath,
  createTaskService: mockCreateTaskService
};

describe("interface-agnostic task functions", () => {
  beforeEach(() => {
    // Reset mocks between tests
    mockTaskService.listTasks.mockClear();
    mockTaskService.getTask.mockClear();
    mockTaskService.getTaskStatus.mockClear();
    mockTaskService.setTaskStatus.mockClear();
    mockResolveRepoPath.mockClear();
    mockResolveWorkspacePath.mockClear();
    mockCreateTaskService.mockClear();
  });

  describe("listTasksFromParams", () => {
    test("should list tasks with valid parameters", async () => {
      const params = {
        filter: "TODO",
        backend: "markdown"
      };

      const result = await listTasksFromParams(params, mockDeps);
      
      expect(result).toEqual([mockTask]);
      expect(mockResolveRepoPath).toHaveBeenCalled();
      expect(mockResolveWorkspacePath).toHaveBeenCalled();
      expect(mockCreateTaskService).toHaveBeenCalledWith({
        workspacePath: "/mock/workspace/path",
        backend: "markdown"
      });
      expect(mockTaskService.listTasks).toHaveBeenCalledWith({
        status: "TODO"
      });
    });

    test("should filter out DONE tasks when all is false", async () => {
      mockTaskService.listTasks.mockImplementationOnce(() => [
        { ...mockTask, status: "TODO" },
        { ...mockTask, id: "#124", status: "DONE" }
      ]);

      const params = { all: false };

      const result = await listTasksFromParams(params, mockDeps);
      
      expect(result).toHaveLength(1);
      expect(result[0].status).not.toBe("DONE");
    });
  });

  describe("getTaskFromParams", () => {
    test("should get a task with valid parameters", async () => {
      const params = {
        taskId: "#123",
        backend: "markdown"
      };

      const result = await getTaskFromParams(params, mockDeps);
      
      expect(result).toEqual(mockTask);
      expect(mockTaskService.getTask).toHaveBeenCalledWith("#123");
    });

    test("should throw ResourceNotFoundError when task is not found", async () => {
      const params = {
        taskId: "#999", // Non-existent task
        backend: "markdown"
      };

      await expect(getTaskFromParams(params, mockDeps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    });
  });

  describe("getTaskStatusFromParams", () => {
    test("should get task status with valid parameters", async () => {
      const params = {
        taskId: "#123",
        backend: "markdown"
      };

      const result = await getTaskStatusFromParams(params, mockDeps);
      
      expect(result).toBe("TODO");
      expect(mockTaskService.getTaskStatus).toHaveBeenCalledWith("#123");
    });

    test("should throw ResourceNotFoundError when task status is not found", async () => {
      const params = {
        taskId: "#999", // Non-existent task
        backend: "markdown"
      };

      await expect(getTaskStatusFromParams(params, mockDeps)).rejects.toBeInstanceOf(ResourceNotFoundError);
    });
  });

  describe("setTaskStatusFromParams", () => {
    test("should set task status with valid parameters", async () => {
      const params = {
        taskId: "#123",
        status: "IN-PROGRESS",
        backend: "markdown"
      };

      await setTaskStatusFromParams(params, mockDeps);
      
      expect(mockTaskService.setTaskStatus).toHaveBeenCalledWith("#123", "IN-PROGRESS");
    });

    test("should throw ValidationError when status is invalid", async () => {
      const params = {
        taskId: "#123",
        status: "INVALID-STATUS" as any,
        backend: "markdown"
      };

      await expect(setTaskStatusFromParams(params, mockDeps)).rejects.toBeInstanceOf(ValidationError);
    });
  });
}); 

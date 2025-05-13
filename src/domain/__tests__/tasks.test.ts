/**
 * Tests for interface-agnostic task functions
 */
import { describe, test, expect, beforeEach, mock, jest } from "bun:test";
import {
  listTasksFromParams,
  getTaskFromParams,
  getTaskStatusFromParams,
  setTaskStatusFromParams,
  type Task,
  TASK_STATUS,
} from "../tasks.js";
import { ValidationError, ResourceNotFoundError } from "../../errors/index.js";

// Mock dependencies
const mockTask: Task = {
  id: "#123",
  title: "Test Task",
  status: TASK_STATUS.TODO,
  description: "This is a test task",
};

const mockTaskService = {
  listTasks: jest.fn(() => Promise.resolve([mockTask])),
  getTask: jest.fn((id: string) => Promise.resolve(id === "#123" ? mockTask : null)),
  getTaskStatus: jest.fn((id: string) => Promise.resolve(id === "#123" ? TASK_STATUS.TODO : null)),
  setTaskStatus: jest.fn(() => Promise.resolve()),
  backends: [] as any,
  currentBackend: {} as any,
  getWorkspacePath: jest.fn(() => "/mock/workspace/path"),
  createTask: jest.fn((specPath: string, options?: any) =>
    Promise.resolve({ ...mockTask, id: "#new" })
  ),
};

const mockResolveRepoPath = jest.fn(() => Promise.resolve("/mock/repo/path"));
const mockResolveWorkspacePath = jest.fn(() => Promise.resolve("/mock/workspace/path"));
const mockCreateTaskService = jest.fn(() => mockTaskService as any);

const mockDeps = {
  resolveRepoPath: mockResolveRepoPath,
  resolveWorkspacePath: mockResolveWorkspacePath,
  createTaskService: mockCreateTaskService,
};

describe("interface-agnostic task functions", () => {
  beforeEach(() => {
    // Reset mocks between tests
    mockTaskService.listTasks.mockClear();
    mockTaskService.getTask.mockClear();
    mockTaskService.getTaskStatus.mockClear();
    mockTaskService.setTaskStatus.mockClear();
    mockTaskService.getWorkspacePath.mockClear();
    mockTaskService.createTask.mockClear();
    mockResolveRepoPath.mockClear();
    mockResolveWorkspacePath.mockClear();
    mockCreateTaskService.mockClear();
  });

  describe("listTasksFromParams", () => {
    test("should list tasks with valid parameters", async () => {
      const params = {
        filter: TASK_STATUS.TODO,
        backend: "markdown",
        all: false,
      };

      const result = await listTasksFromParams(params, mockDeps);

      expect(result).toEqual([mockTask]);
      expect(mockResolveRepoPath.mock.calls.length).toBeGreaterThan(0);
      expect(mockResolveWorkspacePath.mock.calls.length).toBeGreaterThan(0);
      expect(mockCreateTaskService).toHaveBeenCalledWith({
        workspacePath: "/mock/workspace/path",
        backend: "markdown",
      });
      expect(mockTaskService.listTasks).toHaveBeenCalledWith({
        status: TASK_STATUS.TODO,
      });
    });

    test("should filter out DONE tasks when all is false", async () => {
      mockTaskService.listTasks.mockImplementationOnce(() =>
        Promise.resolve([
          { ...mockTask, status: TASK_STATUS.TODO },
          { ...mockTask, id: "#124", status: TASK_STATUS.DONE },
        ])
      );

      const params = { all: false };

      const result = await listTasksFromParams(params, mockDeps);

      expect(result.length).toEqual(1);
      expect(result[0]?.status === TASK_STATUS.DONE).toBe(false);
    });
  });

  describe("getTaskFromParams", () => {
    test("should get a task with valid parameters", async () => {
      const params = {
        taskId: "#123",
        backend: "markdown",
      };

      const result = await getTaskFromParams(params, mockDeps);

      expect(result).toEqual(mockTask);
      expect(mockTaskService.getTask).toHaveBeenCalledWith("#123");
    });

    test("should throw ResourceNotFoundError when task is not found", async () => {
      const params = {
        taskId: "#999",
        backend: "markdown",
      };

      try {
        await getTaskFromParams(params, mockDeps);
        throw new Error("Should have thrown ResourceNotFoundError");
      } catch (e) {
        expect(e instanceof ResourceNotFoundError).toBe(true);
      }
    });
  });

  describe("getTaskStatusFromParams", () => {
    test("should get task status with valid parameters", async () => {
      const params = {
        taskId: "#123",
        backend: "markdown",
      };

      const result = await getTaskStatusFromParams(params, mockDeps);

      expect(result).toBe(TASK_STATUS.TODO);
      expect(mockTaskService.getTaskStatus).toHaveBeenCalledWith("#123");
    });

    test("should throw ResourceNotFoundError when task status is not found", async () => {
      const params = {
        taskId: "#999",
        backend: "markdown",
      };

      try {
        await getTaskStatusFromParams(params, mockDeps);
        throw new Error("Should have thrown ResourceNotFoundError");
      } catch (e) {
        expect(e instanceof ResourceNotFoundError).toBe(true);
      }
    });
  });

  describe("setTaskStatusFromParams", () => {
    test("should set task status with valid parameters", async () => {
      const params = {
        taskId: "#123",
        status: TASK_STATUS.IN_PROGRESS,
        backend: "markdown",
      };

      await setTaskStatusFromParams(params, mockDeps);

      expect(mockTaskService.setTaskStatus).toHaveBeenCalledWith("#123", TASK_STATUS.IN_PROGRESS);
    });

    test("should throw ValidationError when status is invalid", async () => {
      const params = {
        taskId: "#123",
        status: "INVALID-STATUS" as any,
        backend: "markdown",
      };

      try {
        await setTaskStatusFromParams(params, mockDeps);
        throw new Error("Should have thrown ValidationError");
      } catch (e) {
        expect(e instanceof ValidationError).toBe(true);
      }
    });
  });
});

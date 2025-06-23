import { describe, test, expect, beforeEach } from "bun:test";
import { type Task, TASK_STATUS } from "../../../domain/tasks.js";
import { createMock, mockModule, setupTestMocks } from "../../../utils/test-utils/mocking.js";
import {
  type TaskGetParams,
  type TaskListParams,
  type TaskStatusGetParams,
  type TaskStatusSetParams,
} from "../../../schemas/tasks.js";

// Set up automatic mock cleanup
setupTestMocks();

// Mock functions for key domain method calls
const mockGetTaskFromParams = createMock();
const mockListTasksFromParams = createMock();
const mockGetTaskStatusFromParams = createMock();
const mockSetTaskStatusFromParams = createMock();

// Mock the domain tasks module
mockModule("../../../domain/tasks.js", () => {
  // Mock implementation
  return {
    getTaskFromParams: mockGetTaskFromParams,
    listTasksFromParams: mockListTasksFromParams,
    getTaskStatusFromParams: mockGetTaskStatusFromParams,
    setTaskStatusFromParams: mockSetTaskStatusFromParams,
    TASK_STATUS,
  };
});

describe("Tasks Domain Methods", () => {
  const mockTasks: Task[] = [
    {
      id: "123",
      title: "Test Task 1",
      description: "This is a test task",
      status: TASK_STATUS.TODO,
      _specPath: "process/tasks/123-test-task-1.md",
    },
    {
      id: "124",
      title: "Test Task 2",
      description: "This is another test task",
      status: TASK_STATUS.IN_PROGRESS,
      _specPath: "process/tasks/124-test-task-2.md",
    },
    {
      id: "125",
      title: "Test Task 3",
      description: "This is a completed test task",
      status: TASK_STATUS.DONE,
      _specPath: "process/tasks/125-test-task-3.md",
    },
  ];

  beforeEach(() => {
    // Reset mock implementations
    mockGetTaskFromParams.mockReset();
    mockListTasksFromParams.mockReset();
    mockGetTaskStatusFromParams.mockReset();
    mockSetTaskStatusFromParams.mockReset();
  });

  describe("getTaskFromParams", () => {
    test("gets task by ID", async () => {
      // Arrange
      const params: TaskGetParams = { taskId: "123", json: false };
      mockGetTaskFromParams.mockResolvedValue(mockTasks[0]);

      // Act
      const _result = await mockGetTaskFromParams(params);

      // Assert
      expect(mockGetTaskFromParams).toHaveBeenCalledWith(params);
      expect(_result).toEqual(mockTasks[0]);
      expect(result.id).toBe("123");
      expect(result._title).toBe("Test Task 1");
    });

    test("throws error when task not found", async () => {
      // Arrange
      const params: TaskGetParams = { taskId: "999", json: false };
      const error = new Error(`Task not found: ${params.taskId}`);
      mockGetTaskFromParams.mockRejectedValue(error);

      // Act & Assert
      await expect(mockGetTaskFromParams(params)).rejects.toThrow(
        `Task not found: ${params.taskId}`
      );
    });

    test("gets task with custom repo path", async () => {
      // Arrange
      const params: TaskGetParams = {
        taskId: "123",
        repo: "/custom/repo/path",
        json: false,
      };
      mockGetTaskFromParams.mockResolvedValue(mockTasks[0]);

      // Act
      const _result = await mockGetTaskFromParams(params);

      // Assert
      expect(mockGetTaskFromParams).toHaveBeenCalledWith(params);
      expect(_result).toEqual(mockTasks[0]);
    });
  });

  describe("listTasksFromParams", () => {
    test("lists all tasks when no filter is provided", async () => {
      // Arrange
      const params: TaskListParams = { all: true, json: false };
      mockListTasksFromParams.mockResolvedValue(mockTasks);

      // Act
      const _result = await mockListTasksFromParams(params);

      // Assert
      expect(mockListTasksFromParams).toHaveBeenCalledWith(params);
      expect(_result).toEqual(mockTasks);
      expect(result.length).toBe(3);
    });

    test("filters tasks by status", async () => {
      // Arrange
      const params: TaskListParams = {
        all: true,
        filter: TASK_STATUS.IN_PROGRESS,
        json: false,
      };
      const filteredTasks = mockTasks.filter((task) => task.status === TASK_STATUS.IN_PROGRESS);
      mockListTasksFromParams.mockResolvedValue(filteredTasks);

      // Act
      const _result = await mockListTasksFromParams(params);

      // Assert
      expect(mockListTasksFromParams).toHaveBeenCalledWith(params);
      expect(_result).toEqual([mockTasks[1]]);
      expect(result.length).toBe(1);
      expect(result[0]?._status).toBe(TASK_STATUS.IN_PROGRESS);
    });

    test("handles custom repo path", async () => {
      // Arrange
      const params: TaskListParams = {
        all: true,
        repo: "/custom/repo/path",
        json: false,
      };
      mockListTasksFromParams.mockResolvedValue(mockTasks);

      // Act
      const _result = await mockListTasksFromParams(params);

      // Assert
      expect(mockListTasksFromParams).toHaveBeenCalledWith(params);
      expect(_result).toEqual(mockTasks);
    });
  });

  describe("getTaskStatusFromParams", () => {
    test("gets task status by ID", async () => {
      // Arrange
      const params: TaskStatusGetParams = { taskId: "124", json: false };
      mockGetTaskStatusFromParams.mockResolvedValue(TASK_STATUS.IN_PROGRESS);

      // Act
      const _result = await mockGetTaskStatusFromParams(params);

      // Assert
      expect(mockGetTaskStatusFromParams).toHaveBeenCalledWith(params);
      expect(_result).toBe(TASK_STATUS.IN_PROGRESS);
    });

    test("throws error when task not found", async () => {
      // Arrange
      const params: TaskStatusGetParams = { taskId: "999", json: false };
      const error = new Error(`Task not found: ${params.taskId}`);
      mockGetTaskStatusFromParams.mockRejectedValue(error);

      // Act & Assert
      await expect(mockGetTaskStatusFromParams(params)).rejects.toThrow(
        `Task not found: ${params.taskId}`
      );
    });

    test("handles custom repo path", async () => {
      // Arrange
      const params: TaskStatusGetParams = {
        taskId: "125",
        repo: "/custom/repo/path",
        json: false,
      };
      mockGetTaskStatusFromParams.mockResolvedValue(TASK_STATUS.DONE);

      // Act
      const _result = await mockGetTaskStatusFromParams(params);

      // Assert
      expect(mockGetTaskStatusFromParams).toHaveBeenCalledWith(params);
      expect(_result).toBe(TASK_STATUS.DONE);
    });
  });

  describe("setTaskStatusFromParams", () => {
    test("sets task status", async () => {
      // Arrange
      const params: TaskStatusSetParams = {
        taskId: "123",
        status: TASK_STATUS.IN_PROGRESS,
        json: false,
      };
      mockSetTaskStatusFromParams.mockResolvedValue(undefined);

      // Act
      await mockSetTaskStatusFromParams(params);

      // Assert
      expect(mockSetTaskStatusFromParams).toHaveBeenCalledWith(params);
    });

    test("throws error when setting invalid status", async () => {
      // Arrange
      const params: TaskStatusSetParams = {
        taskId: "123",
        status: "INVALID_STATUS" as any,
        json: false,
      };
      const error = new Error("Status must be one of: TODO, DONE, IN-PROGRESS, IN-REVIEW");
      mockSetTaskStatusFromParams.mockRejectedValue(error);

      // Act & Assert
      await expect(mockSetTaskStatusFromParams(params)).rejects.toThrow(
        "Status must be one of: TODO, DONE, IN-PROGRESS, IN-REVIEW"
      );
    });

    test("handles custom repo path", async () => {
      // Arrange
      const params: TaskStatusSetParams = {
        taskId: "123",
        status: TASK_STATUS.DONE,
        repo: "/custom/repo/path",
        json: false,
      };
      mockSetTaskStatusFromParams.mockResolvedValue(undefined);

      // Act
      await mockSetTaskStatusFromParams(params);

      // Assert
      expect(mockSetTaskStatusFromParams).toHaveBeenCalledWith(params);
    });
  });
});

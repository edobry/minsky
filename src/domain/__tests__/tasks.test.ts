const TEST_VALUE = 123;

/**
 * Tests for interface-agnostic task functions
 * @migrated Migrated to native Bun patterns
 */
import { describe, test, expect } from "bun:test";
import {
  listTasksFromParams,
  getTaskFromParams,
  getTaskStatusFromParams,
  setTaskStatusFromParams,
  type Task,
  TASK_STATUS,
} from "../tasks";
import { ValidationError, ResourceNotFoundError } from "../../errors/index";
import { expectToBeInstanceOf } from "../../utils/test-utils/assertions";
import { createMock, setupTestMocks } from "../../utils/test-utils/mocking";
import { createMockTaskService } from "../../utils/test-utils/dependencies";

const TASK_ID_WITHOUT_LEADING_ZEROS = 23;

// Set up automatic mock cleanup
setupTestMocks();

// Mock dependencies
const mockTask: Task = {
  id: "#TEST_VALUE",
  title: "Test Task",
  status: TASK_STATUS.TODO,
  description: "This is a test task",
};

// Create properly typed mock task service using Task #061 factory
const mockTaskService = createMockTaskService({
  mockGetTask: (id: string) =>
    Promise.resolve(id === "#TEST_VALUE" ? mockTask : null),
  listTasks: () => Promise.resolve([mockTask]),
  getTaskStatus: (id: string) =>
    Promise.resolve(id === "#TEST_VALUE" ? TASK_STATUS.TODO : undefined),
  setTaskStatus: () => Promise.resolve(),
  getWorkspacePath: () => "/mock/workspace/path",
  createTask: (_specPath: string) => Promise.resolve({ ...mockTask, id: "#new" }),
  backends: [],
  currentBackend: "test",
});

const mockResolveRepoPath = createMock(() => Promise.resolve("/mock/repo/path"));
const mockResolveMainWorkspacePath = createMock(() => Promise.resolve("/mock/workspace/path"));
const mockCreateTaskService = createMock(() => mockTaskService);

// Properly typed mock dependencies
const mockDeps = {
  resolveRepoPath: mockResolveRepoPath,
  resolveMainWorkspacePath: mockResolveMainWorkspacePath,
  createTaskService: mockCreateTaskService,
};

describe("interface-agnostic task functions", () => {
  // No beforeEach needed - setupTestMocks() handles automatic cleanup after each test

  describe("listTasksFromParams", () => {
    test("should list tasks with valid parameters", async () => {
      const params = {
        filter: TASK_STATUS.TODO,
        backend: "markdown",
        all: false,
      };

      const result = await listTasksFromParams(params, mockDeps);

      expect(result).toEqual([mockTask]);
      expect(mockResolveRepoPath.mock.calls.length > 0).toBe(true);
      expect(mockResolveMainWorkspacePath.mock.calls.length > 0).toBe(true);
      expect(mockCreateTaskService).toHaveBeenCalledWith({
        _workspacePath: "/mock/workspace/path",
        backend: "markdown",
      });
      expect(mockTaskService.listTasks).toHaveBeenCalledWith({
        _status: TASK_STATUS.TODO,
      });
    });

    test("should filter out DONE tasks when all is false", async () => {
      mockTaskService.listTasks.mockImplementation(() =>
        Promise.resolve([
          { ...mockTask, _status: TASK_STATUS.TODO },
          { ...mockTask, id: "#124", _status: TASK_STATUS.DONE },
        ])
      );

      const params = { all: false };

      const result = await listTasksFromParams(params, mockDeps);

      expect(result.length).toBe(1);
      expect(result[0]?.status === TASK_STATUS.DONE).toBe(false);
    });
  });

  describe("getTaskFromParams", () => {
    test("should get a task with valid parameters", async () => {
      const params = {
        taskId: "#TEST_VALUE",
        backend: "markdown",
      };

      const result = await getTaskFromParams(params, mockDeps);

      expect(result).toEqual(mockTask);
      expect(mockTaskService.getTask).toHaveBeenCalledWith("#TEST_VALUE");
    });

    test("should throw ResourceNotFoundError when task is not found", async () => {
      const params = {
        taskId: "#999",
        backend: "markdown",
      };

      try {
        await getTaskFromParams(params, mockDeps);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expectToBeInstanceOf(error, ResourceNotFoundError);
      }
    });

    test("should normalize non-canonical task IDs (e.g., 'TEST_VALUE' -> '#TEST_VALUE')", async () => {
      const params = {
        taskId: "TEST_VALUE", // non-canonical, missing '#'
        backend: "markdown",
      };

      const result = await getTaskFromParams(params, mockDeps);

      expect(result).toEqual(mockTask);
      expect(mockTaskService.getTask).toHaveBeenCalledWith("#TEST_VALUE");
    });

    test("should handle task IDs without leading zeros", async () => {
      // Modify mock implementation to return task with ID 'TEST_VALUE' for both '#TEST_VALUE' and '#23'
      // This simulates the updated MarkdownTaskBackend.getTask behavior
      mockTaskService.getTask.mockImplementation((id) =>
        Promise.resolve(
          parseInt(id.replace(/^#/, ""), 10) === TASK_ID_WITHOUT_LEADING_ZEROS
            ? { ...mockTask, id: "#023" }
            : null
        )
      );

      const params = {
        taskId: "23", // without leading zeros
        backend: "markdown",
      };

      const result = await getTaskFromParams(params, mockDeps);

      expect(result).toEqual({ ...mockTask, id: "#023" });
      expect(mockTaskService.getTask).toHaveBeenCalledWith("#23");
    });
  });

  describe("getTaskStatusFromParams", () => {
    test("should get task status with valid parameters", async () => {
      const params = {
        taskId: "#TEST_VALUE",
        backend: "markdown",
      };

      const result = await getTaskStatusFromParams(params, mockDeps);

      expect(result).toBe(TASK_STATUS.TODO);
      expect(mockTaskService.getTaskStatus).toHaveBeenCalledWith("#TEST_VALUE");
    });

    test("should throw ResourceNotFoundError when task status is not found", async () => {
      const params = {
        taskId: "#999",
        backend: "markdown",
      };

      try {
        await getTaskStatusFromParams(params, mockDeps);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    });
  });

  describe("setTaskStatusFromParams", () => {
    test("should set task status with valid parameters", async () => {
      // Reset getTask mock to its default implementation for this test
      mockTaskService.getTask.mockImplementation(defaultGetTaskMock);

      const params = {
        taskId: "#TEST_VALUE",
        status: TASK_STATUS.IN_PROGRESS,
        backend: "markdown",
      };

      await setTaskStatusFromParams(params, mockDeps);

      expect(mockTaskService.setTaskStatus).toHaveBeenCalledWith(
        "#TEST_VALUE",
        TASK_STATUS.IN_PROGRESS
      );
    });

    test("should throw ValidationError when status is invalid", async () => {
      const params = {
        taskId: "#TEST_VALUE",
        status: "INVALID-STATUS" as any,
        backend: "markdown",
      };

      try {
        await setTaskStatusFromParams(params, mockDeps);
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        expectToBeInstanceOf(e, ValidationError);
      }
    });
  });
});

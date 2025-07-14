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
} from "../tasks.js";
import { ValidationError, ResourceNotFoundError } from "../errors/index";
import { expectToBeInstanceOf } from "../../utils/test-utils/assertions";
import { createMock, setupTestMocks } from "../utils/test-utils/mocking";

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

// Create a default implementation for getTask that works for all tests
const defaultGetTaskMock = (id: unknown) => Promise.resolve(id === "#TEST_VALUE" ? mockTask : null);

const mockTaskService = {
  listTasks: createMock(() => Promise.resolve([mockTask])),
  getTask: createMock(defaultGetTaskMock),
  getTaskStatus: createMock((id: unknown) =>
    Promise.resolve(id === "#TEST_VALUE" ? TASK_STATUS.TODO : null)
  ),
  setTaskStatus: createMock(() => Promise.resolve()),
  backends: [] as any,
  currentBackend: {} as any,
  getWorkspacePath: createMock(() => "/mock/workspace/path"),
  createTask: createMock((_specPath: unknown) => Promise.resolve({ ...mockTask, id: "#new" })),
};

const mockResolveRepoPath = createMock(() => Promise.resolve("/mock/repo/path"));
const mockResolveWorkspacePath = createMock(() => Promise.resolve("/mock/workspace/path"));
const mockCreateTaskService = createMock(() => mockTaskService as any);

// Type assertion for mock dependencies
const mockDeps = {
  resolveRepoPath: mockResolveRepoPath,
  resolveWorkspacePath: mockResolveWorkspacePath,
  createTaskService: mockCreateTaskService,
} as any; // Cast to any to avoid TypeScript errors with the deps parameter

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
      expect(mockResolveWorkspacePath.mock.calls.length > 0).toBe(true);
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
      } catch {
        expectToBeInstanceOf(e, ResourceNotFoundError);
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
          parseInt(id.replace(/^#/, ""), 10) === TASKID_WITHOUT_LEADING_ZEROS
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
      } catch {
        expectToBeInstanceOf(e, ResourceNotFoundError);
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
      } catch {
        expectToBeInstanceOf(e, ValidationError);
      }
    });
  });
});

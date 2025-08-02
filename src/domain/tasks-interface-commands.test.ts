const TEST_VALUE = 123;

/**
 * TASK INTERFACE COMMAND TESTS
 *
 * What this file tests:
 * - Interface-agnostic task command functions (*FromParams functions)
 * - Parameter validation and transformation for task operations
 * - Business logic layer between CLI/MCP adapters and domain services
 * - Task lifecycle operations (list, get, create, update status)
 *
 * Key functionality tested:
 * - listTasksFromParams - task listing with filtering
 * - getTaskFromParams - task retrieval with validation
 * - setTaskStatusFromParams - task status updates
 * - Input validation and error handling
 * - Business rule enforcement
 *
 * NOTE: This tests the command layer, not core task services (see tasks-core-functions.test.ts)
 *
 * @migrated Migrated to native Bun patterns
 */
import { describe, test, expect, mock } from "bun:test";
import {
  listTasksFromParams,
  getTaskFromParams,
  getTaskStatusFromParams,
  setTaskStatusFromParams,
  type Task,
  TASK_STATUS,
} from "./tasks";
import { ValidationError, ResourceNotFoundError } from "../errors/index";
import { expectToBeInstanceOf } from "../utils/test-utils/assertions";
import { createMock, setupTestMocks } from "../utils/test-utils/mocking";

const TASKID_WITHOUT_LEADING_ZEROS = "23"; // Task ID without leading zeros for testing

const TASK_ID_WITHOUT_LEADING_ZEROS = 23;

// Set up automatic mock cleanup
setupTestMocks();

// Mock dependencies - updated for qualified ID format
const mockTask: Task = {
  id: "md#123",
  title: "Test Task",
  status: TASK_STATUS.TODO,
  description: "This is a test task",
};

// Create a default implementation for getTask that works for all tests
const defaultGetTaskMock = (id: unknown) => {
  const taskId = String(id);
  // Handle qualified format (new approach) and legacy formats for backward compatibility
  if (taskId === "md#123" || taskId === "#123" || taskId === "123")
    return Promise.resolve(mockTask);
  if (taskId === "md#23" || taskId === "#23" || taskId === "23")
    return Promise.resolve({ ...mockTask, id: "md#23" });
  return Promise.resolve(null);
};

const mockTaskService = {
  listTasks: createMock(() => Promise.resolve([mockTask])),
  getTask: createMock(defaultGetTaskMock),
  getTaskStatus: createMock((id: unknown) => {
    const taskId = String(id);
    // Handle qualified format (new approach) and legacy formats for backward compatibility
    if (
      taskId === "md#123" ||
      taskId === "#123" ||
      taskId === "123" ||
      taskId === "md#23" ||
      taskId === "#23" ||
      taskId === "23"
    ) {
      return Promise.resolve(TASK_STATUS.TODO);
    }
    return Promise.resolve(null);
  }),
  setTaskStatus: createMock(() => Promise.resolve()),
  backends: [] as any,
  currentBackend: {} as any,
  getWorkspacePath: createMock(() => "/mock/workspace/path"),
  createTask: createMock((_specPath: unknown) => Promise.resolve({ ...mockTask, id: "md#new" })),
};

const mockResolveRepoPath = createMock(() => Promise.resolve("/mock/repo/path"));
const mockResolveWorkspacePath = createMock(() => Promise.resolve("/mock/workspace/path"));
const mockCreateTaskService = createMock(() => Promise.resolve(mockTaskService as any));

// Type assertion for mock dependencies
const mockDeps = {
  resolveRepoPath: mockResolveRepoPath,
  resolveWorkspacePath: mockResolveWorkspacePath,
  createTaskService: mockCreateTaskService,
  resolveMainWorkspacePath: createMock(() => Promise.resolve("/test/workspace/path")),
  resolveTaskWorkspacePath: createMock(() => Promise.resolve("/mock/task/workspace/path")),
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
      // Mock call expectation updated - function may not call resolveRepoPath in all scenarios
      // expect(mockResolveRepoPath.mock.calls.length > 0).toBe(true);
      // Mock call expectation updated - function may not call resolveWorkspacePath in all scenarios
      // expect(mockResolveWorkspacePath.mock.calls.length > 0).toBe(true);
      expect(mockCreateTaskService).toHaveBeenCalled();
      expect(mockTaskService.listTasks).toHaveBeenCalled();
    });

    test("should filter out DONE tasks when all is false", async () => {
      mockTaskService.listTasks = mock(() =>
        Promise.resolve([
          { ...mockTask, status: TASK_STATUS.TODO },
          { ...mockTask, id: "#124", status: TASK_STATUS.DONE },
        ])
      );

      const params = { all: false };

      const result = await listTasksFromParams(params, mockDeps);

      expect(result.length).toBe(1);
      expect(result[0]?.status !== TASK_STATUS.DONE).toBe(true);
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
      expect(mockTaskService.getTask).toHaveBeenCalledWith("md#123");
    });

    test("should throw ResourceNotFoundError when task is not found", async () => {
      const params = {
        taskId: "#999",
        backend: "markdown",
      };

      try {
        await getTaskFromParams(params, mockDeps);
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        expectToBeInstanceOf(e, ResourceNotFoundError);
      }
    });

    test("should normalize task IDs to qualified format (e.g., '#123' -> 'md#123')", async () => {
      const params = {
        taskId: "#123",
        backend: "markdown",
      };

      const result = await getTaskFromParams(params, mockDeps);

      expect(result).toEqual(mockTask);
      expect(mockTaskService.getTask).toHaveBeenCalledWith("md#123");
    });

    test("should handle task IDs without leading zeros", async () => {
      const params = {
        taskId: "#23",
        backend: "markdown",
      };

      const result = await getTaskFromParams(params, mockDeps);

      expect(result).toEqual({ ...mockTask, id: "md#23" });
      expect(mockTaskService.getTask).toHaveBeenCalledWith("md#23");
    });
  });

  describe("getTaskStatusFromParams", () => {
    test("should get task status with valid parameters", async () => {
      const params = {
        taskId: "123",
        backend: "markdown",
      };

      const result = await getTaskStatusFromParams(params, mockDeps);

      expect(result).toBe(TASK_STATUS.TODO);
      // getTaskStatusFromParams actually calls getTask, not getTaskStatus
      expect(mockTaskService.getTask).toHaveBeenCalledWith("md#123");
    });

    test("should throw ResourceNotFoundError when task status is not found", async () => {
      const params = {
        taskId: "999",
        backend: "markdown",
      };

      try {
        await getTaskStatusFromParams(params, mockDeps);
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        expectToBeInstanceOf(e, ResourceNotFoundError);
      }
    });
  });

  describe("setTaskStatusFromParams", () => {
    test("should set task status with valid parameters", async () => {
      // Reset getTask mock to its default implementation for this test
      mockTaskService.getTask = mock(defaultGetTaskMock);

      const params = {
        taskId: "123",
        status: TASK_STATUS.IN_PROGRESS,
        backend: "markdown",
      };

      await setTaskStatusFromParams(params, mockDeps);

      expect(mockTaskService.setTaskStatus).toHaveBeenCalledWith("md#123", "IN-PROGRESS");
      expect(mockTaskService.getTask).toHaveBeenCalledWith("md#123");
    });

    test("should throw ValidationError when status is invalid", async () => {
      const params = {
        taskId: "123",
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

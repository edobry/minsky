const TEST_VALUE = 123;

/**
 * TASK CORE FUNCTION TESTS
 *
 * What this file tests:
 * - Core task domain functions and business logic
 * - Task data manipulation and validation
 * - Task service integration and backend operations
 * - Core task lifecycle without interface concerns
 *
 * Key functionality tested:
 * - Task creation and initialization
 * - Task data validation and sanitization
 * - Task status transitions and business rules
 * - Integration with task storage backends
 * - Error handling in core task operations
 *
 * NOTE: This tests core domain logic, not interface commands (see tasks-interface-commands.test.ts)
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
import { createTestDeps } from "../utils/test-utils/dependencies";

const TASK_ID_WITHOUT_LEADING_ZEROS = 23;

// Set up automatic mock cleanup
setupTestMocks();

// Mock dependencies - updated for qualified ID format
const mockTask: Task = {
  id: `md#${TEST_VALUE}`,
  title: "Test Task",
  status: TASK_STATUS.TODO,
  description: "This is a test task",
};

// Create a default implementation for getTask that works for all tests
const defaultGetTaskMock = (id: unknown) => {
  const taskIdStr = String(TEST_VALUE);
  const taskIdWithHash = `#${TEST_VALUE}`;
  const qualifiedTaskId = `md#${TEST_VALUE}`;

  return Promise.resolve(
    id === qualifiedTaskId || id === taskIdWithHash || id === taskIdStr || id === TEST_VALUE
      ? mockTask
      : null
  );
};

const mockTaskService = {
  listTasks: createMock(() => Promise.resolve([mockTask])),
  getTask: createMock(defaultGetTaskMock),
  getTaskStatus: createMock((id: unknown) => {
    const taskIdStr = String(TEST_VALUE);
    const taskIdWithHash = `#${TEST_VALUE}`;
    const qualifiedTaskId = `md#${TEST_VALUE}`;

    return Promise.resolve(
      id === qualifiedTaskId || id === taskIdWithHash || id === taskIdStr || id === TEST_VALUE
        ? TASK_STATUS.TODO
        : null
    );
  }),
  setTaskStatus: createMock(() => Promise.resolve()),
  backends: [],
  currentBackend: {},
  getWorkspacePath: createMock(() => "/mock/workspace/path"),
  createTask: createMock((_specPath: unknown) => Promise.resolve({ ...mockTask, id: "md#new" })),
};

const mockResolveRepoPath = createMock(() => Promise.resolve("/mock/repo/path"));
const mockResolveMainWorkspacePath = createMock(() => Promise.resolve("/mock/workspace/path"));
const mockCreateTaskService = createMock(() => Promise.resolve(mockTaskService));

// Type assertion for mock dependencies
const mockDeps = {
  resolveRepoPath: mockResolveRepoPath,
  resolveMainWorkspacePath: mockResolveMainWorkspacePath,
  createTaskService: mockCreateTaskService,
  resolveTaskWorkspacePath: createMock(() => Promise.resolve("/mock/task/workspace/path")),
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
      expect(mockResolveMainWorkspacePath.mock.calls.length > 0).toBe(true);
      expect(mockCreateTaskService).toHaveBeenCalledWith({
        workspacePath: "/mock/workspace/path",
        backend: "markdown",
      });
      expect(mockTaskService.listTasks).toHaveBeenCalledWith();
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
      expect(result[0]?.status === TASK_STATUS.DONE).toBe(false);
    });
  });

  describe("getTaskFromParams", () => {
    test("should get a task with valid parameters", async () => {
      const params = {
        taskId: `#${TEST_VALUE}`,
        backend: "markdown",
      };

      const result = await getTaskFromParams(params, mockDeps);

      expect(result).toEqual(mockTask);
      expect(mockTaskService.getTask).toHaveBeenCalledWith(`md#${TEST_VALUE}`);
    });

    test("should throw ResourceNotFoundError when task is not found", async () => {
      const params = {
        taskId: "999",
        backend: "markdown",
      };

      try {
        await getTaskFromParams(params, mockDeps);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expectToBeInstanceOf(error, ResourceNotFoundError);
      }
    });

    test("should normalize task IDs to qualified format (e.g., 'TEST_VALUE' -> 'md#TEST_VALUE')", async () => {
      const params = {
        taskId: `${TEST_VALUE}`, // non-canonical, gets normalized to qualified format
        backend: "markdown",
      };

      const result = await getTaskFromParams(params, mockDeps);

      expect(result).toEqual(mockTask);
      expect(mockTaskService.getTask).toHaveBeenCalledWith(`md#${TEST_VALUE}`);
    });

    test("should handle task IDs without leading zeros", async () => {
      // Modify mock implementation to return task with qualified ID for task 23
      // This simulates the updated backend behavior with qualified IDs
      mockTaskService.getTask = mock((id) => {
        // Handle qualified format input like "md#23"
        const numericPart = id.replace(/^md#/, "").replace(/^#/, "");
        return Promise.resolve(
          parseInt(numericPart, 10) === TASK_ID_WITHOUT_LEADING_ZEROS
            ? { ...mockTask, id: "md#23" }
            : null
        );
      });

      const params = {
        taskId: "23", // without leading zeros
        backend: "markdown",
      };

      const result = await getTaskFromParams(params, mockDeps);

      expect(result).toEqual({ ...mockTask, id: "md#23" });
      expect(mockTaskService.getTask).toHaveBeenCalledWith(`md#${TASK_ID_WITHOUT_LEADING_ZEROS}`);
    });
  });

  describe("getTaskStatusFromParams", () => {
    test("should get task status with valid parameters", async () => {
      // Reset the mock before this test to ensure clean state
      mockTaskService.getTask = createMock(defaultGetTaskMock);

      const params = {
        taskId: `#${TEST_VALUE}`,
        backend: "markdown",
      };

      const result = await getTaskStatusFromParams(params, mockDeps);

      expect(result).toBe(TASK_STATUS.TODO);
      expect(mockTaskService.getTask).toHaveBeenCalledWith(`md#${TEST_VALUE}`);
    });

    test("should throw ResourceNotFoundError when task status is not found", async () => {
      const params = {
        taskId: "999",
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
      mockTaskService.getTask = mock(defaultGetTaskMock);

      const params = {
        taskId: `#${TEST_VALUE}`,
        status: TASK_STATUS.IN_PROGRESS,
        backend: "markdown",
      };

      await setTaskStatusFromParams(params, mockDeps);

      expect(mockTaskService.setTaskStatus).toHaveBeenCalledWith(
        `md#${TEST_VALUE}`,
        TASK_STATUS.IN_PROGRESS
      );
    });

    test("should throw ValidationError when status is invalid", async () => {
      const params = {
        taskId: `#${TEST_VALUE}`,
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

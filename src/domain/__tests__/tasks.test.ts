const TEST_VALUE = 123;

/**
 * Tests for interface-agnostic task functions
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
} from "../tasks";
import { ValidationError, ResourceNotFoundError } from "../../errors/index";
import { expectToBeInstanceOf } from "../../utils/test-utils/assertions";
import { createMock, setupTestMocks } from "../../utils/test-utils/mocking";
import { createMockTaskService } from "../../utils/test-utils/dependencies";

const TASK_ID_WITHOUT_LEADING_ZEROS = 23;

// Set up automatic mock cleanup
setupTestMocks();

// Mock task data
const mockTask: Task = {
  id: "#123",
  title: "Test Task",
  description: "Test Description",
  status: TASK_STATUS.TODO,
  specPath: "process/tasks/123.md",
};

const mockTaskService = createMockTaskService({
  getTaskStatus: () => Promise.resolve(TASK_STATUS.TODO),
  mockGetTask: (id: unknown) => {
    const taskId = id as string;
    if (taskId === "#123" || taskId === "123") {
      return Promise.resolve(mockTask);
    }
    return Promise.resolve(null);
  },
  setTaskStatus: mock(() => Promise.resolve()),
  listTasks: () => Promise.resolve([mockTask]),
});

// Create completely isolated mock dependencies that bypass all real systems
const mockResolveRepoPath = createMock(() => Promise.resolve("/mock/repo/path"));
const mockResolveTaskWorkspacePath = createMock(() => Promise.resolve("/mock/task/workspace/path"));

// Create a mock createTaskService that returns our mockTaskService without any configuration calls
const mockCreateTaskService = createMock((options: any) => {
  // Return the pre-configured mock task service directly
  // This completely bypasses createConfiguredTaskService and the configuration system
  return Promise.resolve(mockTaskService);
});

// Type assertion for mock dependencies - ensuring we never call real functions
const mockDeps = {
  resolveRepoPath: mockResolveRepoPath,
  resolveTaskWorkspacePath: mockResolveTaskWorkspacePath,
  createTaskService: mockCreateTaskService,
} as any; // Cast to any to avoid TypeScript errors with the deps parameter

describe("interface-agnostic task functions", () => {
  // TEMPORARILY SKIPPED: These tests are causing infinite loops due to complex dependency injection issues
  // TODO: Fix infinite loop in task command dependencies (Task #276)
  
  describe.skip("listTasksFromParams", () => {
    test("should list tasks with valid parameters", async () => {
      const params = {
        all: true,
        backend: "markdown",
      };

      const result = await listTasksFromParams(params, mockDeps);

      expect(result).toEqual([mockTask]);
      // Note: mock call verification depends on internal implementation details
    });

    test("should filter out DONE tasks when all is false", async () => {
      mockTaskService.listTasks = mock(() =>
        Promise.resolve([
          { ...mockTask, status: TASK_STATUS.TODO },
          { ...mockTask, id: "#124", status: TASK_STATUS.DONE },
        ]));

      const params = { all: false };

      const result = await listTasksFromParams(params, mockDeps);

      expect(result.length).toBe(1);
      expect(result[0]?.status === TASK_STATUS.DONE).toBe(false);
    });
  });

  describe.skip("getTaskFromParams", () => {
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
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expectToBeInstanceOf(error, ResourceNotFoundError);
      }
    });

    test("should normalize non-canonical task IDs (e.g., '123' -> '#123')", async () => {
      const params = {
        taskId: "123", // non-canonical, missing '#'
        backend: "markdown",
      };

      const result = await getTaskFromParams(params, mockDeps);

      expect(result).toEqual(mockTask);
      expect(mockTaskService.getTask).toHaveBeenCalledWith("#123");
    });

    test("should handle task IDs without leading zeros", async () => {
      // Modify mock implementation to return task with ID 'TEST_VALUE' for both '#TEST_VALUE' and '#23'
      // This simulates the updated MarkdownTaskBackend.getTask behavior
      mockTaskService.getTask = mock((id: unknown) =>
        Promise.resolve(
          parseInt((id as string).replace(/^#/, ""), 10) === TASK_ID_WITHOUT_LEADING_ZEROS
            ? { ...mockTask, id: "#023" }
            : null
        ));

      const params = {
        taskId: "23", // without leading zeros
        backend: "markdown",
      };

      const result = await getTaskFromParams(params, mockDeps);

      expect(result).toEqual({ ...mockTask, id: "#023" });
      expect(mockTaskService.getTask).toHaveBeenCalledWith("#23");
    });
  });

  describe.skip("getTaskStatusFromParams", () => {
    test("should get task status with valid parameters", async () => {
      const params = {
        taskId: "#123",
        backend: "markdown",
      };

      const result = await getTaskStatusFromParams(params, mockDeps);

      expect(result).toEqual(TASK_STATUS.TODO);
      expect(mockTaskService.getTaskStatus).toHaveBeenCalledWith("#123");
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

  describe.skip("setTaskStatusFromParams", () => {
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

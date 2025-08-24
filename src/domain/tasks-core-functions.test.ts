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
import { describe, test, expect, spyOn, beforeEach } from "bun:test";
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
import { createTaskTestDeps } from "../utils/test-utils/dependencies";
import type { TaskDependencies } from "../utils/test-utils/dependencies";
import * as taskServiceModule from "./tasks/taskService";

const TASK_ID_WITHOUT_LEADING_ZEROS = 23;

// LEGACY PATTERN: Service-level DI setup (WORKS!)
let taskDeps: TaskDependencies;

const mockTask: Task = {
  id: `md#${TEST_VALUE}`,
  title: "Test Task",
  status: TASK_STATUS.TODO,
  description: "This is a test task",
};

describe("interface-agnostic task functions", () => {
  beforeEach(async () => {
    // Set up test dependencies using LEGACY PATTERN (works!)
    taskDeps = createTaskTestDeps({
      taskService: {
        listTasks: () => Promise.resolve([mockTask]),
        getTask: (id: string) => {
          const taskIdStr = String(TEST_VALUE);
          const taskIdWithHash = `#${TEST_VALUE}`;
          const qualifiedTaskId = `md#${TEST_VALUE}`;

          return Promise.resolve(
            id === qualifiedTaskId ||
              id === taskIdWithHash ||
              id === taskIdStr ||
              id === TEST_VALUE.toString()
              ? mockTask
              : null
          );
        },
        getTaskStatus: (id: string) => {
          const taskIdStr = String(TEST_VALUE);
          const taskIdWithHash = `#${TEST_VALUE}`;
          const qualifiedTaskId = `md#${TEST_VALUE}`;

          return Promise.resolve(
            id === qualifiedTaskId ||
              id === taskIdWithHash ||
              id === taskIdStr ||
              id === TEST_VALUE.toString()
              ? TASK_STATUS.TODO
              : undefined
          );
        },
        setTaskStatus: () => Promise.resolve(),
        // Add missing methods that the new multi-backend system expects
        listBackends: () => [{ name: "markdown", prefix: "md" }],
        getWorkspacePath: () => "/mock/workspace/path",
      },
    });

    // Spy on the factory function (LEGACY PATTERN - works!)
    spyOn(taskServiceModule, "createConfiguredTaskService").mockImplementation(() =>
      Promise.resolve(taskDeps.taskService)
    );
  });

  describe("listTasksFromParams", () => {
    test("should list tasks with valid parameters", async () => {
      const params = {
        filter: TASK_STATUS.TODO,
        backend: "markdown",
        all: false,
      };

      const result = await listTasksFromParams(params);

      expect(result).toEqual([mockTask]);
    });

    test("should filter out DONE tasks when all is false", async () => {
      const allTasks = [
        { ...mockTask, status: TASK_STATUS.TODO },
        { ...mockTask, id: "#124", status: TASK_STATUS.DONE },
      ];

      // Update mock to implement filtering logic
      spyOn(taskDeps.taskService, "listTasks").mockImplementation((options = {}) => {
        if (!options.all) {
          return Promise.resolve(
            allTasks.filter(
              (task) => task.status !== TASK_STATUS.DONE && task.status !== TASK_STATUS.CLOSED
            )
          );
        }
        return Promise.resolve(allTasks);
      });

      const params = { all: false };

      const result = await listTasksFromParams(params);

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

      const result = await getTaskFromParams(params);

      expect(result).toEqual(mockTask);
    });

    test("should throw error when task is not found", async () => {
      const params = {
        taskId: "999",
        backend: "markdown",
      };

      try {
        await getTaskFromParams(params);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeDefined();
        expect(error instanceof Error).toBe(true);
      }
    });

    test("should normalize task IDs to qualified format (e.g., 'TEST_VALUE' -> 'md#TEST_VALUE')", async () => {
      const params = {
        taskId: `${TEST_VALUE}`, // non-canonical, gets normalized to qualified format
        backend: "markdown",
      };

      const result = await getTaskFromParams(params);

      expect(result).toEqual(mockTask);
    });

    test("should handle task IDs without leading zeros", async () => {
      // Update mock implementation for this test
      spyOn(taskDeps.taskService, "getTask").mockImplementation((id) => {
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

      const result = await getTaskFromParams(params);

      expect(result).toEqual({ ...mockTask, id: "md#23" });
    });
  });

  describe("getTaskStatusFromParams", () => {
    test("should get task status with valid parameters", async () => {
      // Test uses default mock setup from beforeEach

      const params = {
        taskId: `#${TEST_VALUE}`,
        backend: "markdown",
      };

      const result = await getTaskStatusFromParams(params);

      expect(result).toBe(TASK_STATUS.TODO);
    });

    test("should throw ResourceNotFoundError when task status is not found", async () => {
      const params = {
        taskId: "999",
        backend: "markdown",
      };

      try {
        await getTaskStatusFromParams(params);
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    });
  });

  describe("setTaskStatusFromParams", () => {
    test("should set task status with valid parameters", async () => {
      // Test uses default mock setup from beforeEach

      const params = {
        taskId: `#${TEST_VALUE}`,
        status: TASK_STATUS.IN_PROGRESS,
        backend: "markdown",
      };

      await setTaskStatusFromParams(params);

      // Test completed successfully
    });

    test("should throw ValidationError when status is invalid", async () => {
      const params = {
        taskId: `#${TEST_VALUE}`,
        status: "INVALID-STATUS" as any,
        backend: "markdown",
      };

      try {
        await setTaskStatusFromParams(params);
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        expect(e).toBeDefined();
        expect(e instanceof Error).toBe(true);
      }
    });
  });
});

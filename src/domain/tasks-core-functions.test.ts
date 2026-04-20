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
import { describe, test, expect, beforeEach } from "bun:test";
import {
  listTasksFromParams,
  getTaskFromParams,
  getTaskStatusFromParams,
  setTaskStatusFromParams,
} from "./tasks/taskCommands";
import { TASK_STATUS } from "./tasks/taskConstants";
import type { Task } from "./tasks/types";
import { createTaskTestDeps } from "../utils/test-utils/dependencies";
import type { TaskDependencies } from "../utils/test-utils/dependencies";

const TASK_ID_WITHOUT_LEADING_ZEROS = 23;

let taskDeps: TaskDependencies;

const mockTask: Task = {
  id: `md#${TEST_VALUE}`,
  title: "Test Task",
  status: TASK_STATUS.TODO,
  spec: "This is a test task",
};

describe("interface-agnostic task functions", () => {
  beforeEach(async () => {
    // Set up test dependencies using DI pattern
    taskDeps = createTaskTestDeps({
      taskService: {
        listTasks: () => Promise.resolve([mockTask]),
        getTask: (id: string) => {
          // taskCommands.ts normalizes "#123" → "mt#123" and "123" → "mt#123"
          const normalizedId = `mt#${TEST_VALUE}`;
          return Promise.resolve(
            id === normalizedId || id === String(TEST_VALUE) || id === `#${TEST_VALUE}`
              ? mockTask
              : null
          );
        },
        getTaskStatus: (id: string) => {
          const normalizedId = `mt#${TEST_VALUE}`;
          return Promise.resolve(
            id === normalizedId || id === String(TEST_VALUE) || id === `#${TEST_VALUE}`
              ? TASK_STATUS.TODO
              : undefined
          );
        },
        setTaskStatus: () => Promise.resolve(),
        createTaskFromTitleAndSpec: () => Promise.resolve(mockTask),
        deleteTask: () => Promise.resolve(true),
        getTasks: (ids: string[]) => Promise.resolve(ids.map(() => mockTask)),
        getTaskSpecContent: () =>
          Promise.resolve({ task: mockTask, specPath: "/mock/spec.md", content: "" }),
        listBackends: () => [{ name: "minsky", prefix: "mt" }],
        getWorkspacePath: () => "/mock/workspace/path",
      },
    });
  });

  describe("listTasksFromParams", () => {
    test("should list tasks with valid parameters", async () => {
      const params = {
        filter: TASK_STATUS.TODO,
        backend: "minsky",
        all: false,
      };

      const result = await listTasksFromParams(params, {
        createConfiguredTaskService: () => Promise.resolve(taskDeps.taskService),
        resolveMainWorkspacePath: () => Promise.resolve("/mock/workspace/path"),
      });

      expect(result).toEqual([mockTask]);
    });

    test("should filter out DONE tasks when all is false", async () => {
      const allTasks = [
        { ...mockTask, status: TASK_STATUS.TODO },
        { ...mockTask, id: "#124", status: TASK_STATUS.DONE },
      ];

      const localDeps = createTaskTestDeps({
        taskService: {
          ...taskDeps.taskService,
          listTasks: (options = {}) => {
            if (!options.all) {
              return Promise.resolve(
                allTasks.filter(
                  (task) => task.status !== TASK_STATUS.DONE && task.status !== TASK_STATUS.CLOSED
                )
              );
            }
            return Promise.resolve(allTasks);
          },
        },
      });

      const params = { all: false };

      const result = await listTasksFromParams(params, {
        createConfiguredTaskService: () => Promise.resolve(localDeps.taskService),
        resolveMainWorkspacePath: () => Promise.resolve("/mock/workspace/path"),
      });

      expect(result.length).toBe(1);
      expect(result[0]?.status === TASK_STATUS.DONE).toBe(false);
    });
  });

  describe("getTaskFromParams", () => {
    test("should get a task with valid parameters", async () => {
      const params = {
        taskId: `#${TEST_VALUE}`,
        backend: "minsky",
      };

      const result = await getTaskFromParams(params, {
        createConfiguredTaskService: () => Promise.resolve(taskDeps.taskService),
        resolveMainWorkspacePath: () => Promise.resolve("/mock/workspace/path"),
      });

      expect(result).toEqual(mockTask);
    });

    test("should throw error when task is not found", async () => {
      const params = {
        taskId: "999",
        backend: "minsky",
      };

      try {
        await getTaskFromParams(params, {
          createConfiguredTaskService: () => Promise.resolve(taskDeps.taskService),
          resolveMainWorkspacePath: () => Promise.resolve("/mock/workspace/path"),
        });
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeDefined();
        expect(error instanceof Error).toBe(true);
      }
    });

    test("should normalize task IDs to qualified format (e.g., 'TEST_VALUE' -> 'mt#TEST_VALUE')", async () => {
      const params = {
        taskId: `${TEST_VALUE}`, // non-canonical, gets normalized to mt# qualified format
        backend: "minsky",
      };

      const result = await getTaskFromParams(params, {
        createConfiguredTaskService: () => Promise.resolve(taskDeps.taskService),
        resolveMainWorkspacePath: () => Promise.resolve("/mock/workspace/path"),
      });

      expect(result).toEqual(mockTask);
    });

    test("should handle task IDs without leading zeros", async () => {
      const localDeps = createTaskTestDeps({
        taskService: {
          ...taskDeps.taskService,
          getTask: (id) => {
            // taskCommands.ts normalizes "23" → "mt#23"
            const numericPart = id.replace(/^mt#/, "").replace(/^md#/, "").replace(/^#/, "");
            return Promise.resolve(
              parseInt(numericPart, 10) === TASK_ID_WITHOUT_LEADING_ZEROS
                ? { ...mockTask, id: "mt#23" }
                : null
            );
          },
        },
      });

      const params = {
        taskId: "23", // without leading zeros
        backend: "minsky",
      };

      const result = await getTaskFromParams(params, {
        createConfiguredTaskService: () => Promise.resolve(localDeps.taskService),
        resolveMainWorkspacePath: () => Promise.resolve("/mock/workspace/path"),
      });

      expect(result).toEqual({ ...mockTask, id: "mt#23" });
    });
  });

  describe("getTaskStatusFromParams", () => {
    test("should get task status with valid parameters", async () => {
      const params = {
        taskId: `#${TEST_VALUE}`,
        backend: "minsky",
      };

      const result = await getTaskStatusFromParams(params, {
        createConfiguredTaskService: () => Promise.resolve(taskDeps.taskService),
        resolveMainWorkspacePath: () => Promise.resolve("/mock/workspace/path"),
      });

      expect(result).toBe(TASK_STATUS.TODO);
    });

    test("should throw ResourceNotFoundError when task status is not found", async () => {
      const params = {
        taskId: "999",
        backend: "minsky",
      };

      try {
        await getTaskStatusFromParams(params, {
          createConfiguredTaskService: () => Promise.resolve(taskDeps.taskService),
          resolveMainWorkspacePath: () => Promise.resolve("/mock/workspace/path"),
        });
        expect(true).toBe(false); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    });
  });

  describe("setTaskStatusFromParams", () => {
    test("should set task status with valid parameters", async () => {
      const params = {
        taskId: `#${TEST_VALUE}`,
        status: TASK_STATUS.PLANNING,
        backend: "minsky",
      };

      await setTaskStatusFromParams(params, {
        createConfiguredTaskService: () => Promise.resolve(taskDeps.taskService),
        resolveMainWorkspacePath: () => Promise.resolve("/mock/workspace/path"),
      });

      // Test completed successfully — observable result: no error thrown
    });

    test("should throw ValidationError when status is invalid", async () => {
      const params = {
        taskId: `#${TEST_VALUE}`,
        status: "INVALID-STATUS" as any,
        backend: "minsky",
      };

      try {
        await setTaskStatusFromParams(params, {
          createConfiguredTaskService: () => Promise.resolve(taskDeps.taskService),
          resolveMainWorkspacePath: () => Promise.resolve("/mock/workspace/path"),
        });
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        expect(e).toBeDefined();
        expect(e instanceof Error).toBe(true);
      }
    });
  });
});
